import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagcacheMiddleware } from '../src/tagcache-middleware.js';
import type { TagCache } from '../src/tagcache.js';
import type { CacheFetchOptions, CacheInvalidationOptions, CacheStoreOptions, TagCacheEvent, TagVersionsOptions } from '../src/types/tagcache.js';

/** In-memory stand-in for TagCache with the same tag and version semantics. */
class MemoryTagCache {
    cacheOptions = { cachePrefix: 'c:', tagPrefix: 't:', appContext: 'test', deleteCacheKeys: true, sizeGuard: 2048, cacheTtl: 180, tagTtl: 240, tagIndexMaintenanceMode: 'strict' as const };
    logger = { error: vi.fn() };
    events: TagCacheEvent[] = [];
    onEvent = (event: TagCacheEvent) => this.events.push(event);
    entries = new Map<string, { value: string; tags: string[]; expiresAt: number }>();
    leases = new Map<string, string>();
    staleMs = 60_000;
    versions = new Map<string, number>();
    invalidated: string[][] = [];
    invalidateDelayMs = 0;

    async get(options: CacheFetchOptions) {
        const entry = await this.lookup(options);
        return entry && !entry.stale ? entry.value : null;
    }

    async lookup({ key, tags }: CacheFetchOptions) {
        const entry = this.entries.get(key);
        if (!entry || !tags.every((tag) => entry.tags.includes(tag)) || entry.expiresAt <= Date.now() - this.staleMs) return null;
        return { value: entry.value, expiresAt: entry.expiresAt, stale: entry.expiresAt <= Date.now() };
    }

    leaseTtls: (number | undefined)[] = [];

    async acquireLease({ key, ttlMs }: { key: string; ttlMs?: number }) {
        this.leaseTtls.push(ttlMs);
        if (this.leases.has(key)) return null;
        const token = Math.random().toString(36);
        this.leases.set(key, token);
        return token;
    }

    async releaseLease({ key, token }: { key: string; token: string }) {
        if (this.leases.get(key) !== token) return false;
        return this.leases.delete(key);
    }

    /** Makes every entry expired by `agoMs`. */
    expireAll(agoMs = 1000) {
        for (const entry of this.entries.values()) entry.expiresAt = Date.now() - agoMs;
    }

    async getTagVersions({ tags }: TagVersionsOptions) {
        return { versions: Object.fromEntries(tags.map((tag) => [tag, String(this.versions.get(tag) ?? 0)])) };
    }

    stores: CacheStoreOptions[] = [];

    async set(options: CacheStoreOptions) {
        const { key, value, tags, ifTagVersions, cacheTtl = 180 } = options;
        this.stores.push(options);
        if (ifTagVersions && tags.some((tag) => ifTagVersions.versions[tag] !== String(this.versions.get(tag) ?? 0))) return false;
        this.entries.set(key, { value, tags, expiresAt: Date.now() + cacheTtl * 1000 });
        return true;
    }

    async invalidate({ tags }: CacheInvalidationOptions) {
        await new Promise((resolve) => setTimeout(resolve, this.invalidateDelayMs));
        for (const tag of tags) this.versions.set(tag, (this.versions.get(tag) ?? 0) + 1);
        for (const [key, entry] of this.entries) if (entry.tags.some((tag) => tags.includes(tag))) this.entries.delete(key);
        this.invalidated.push(tags);
        return true;
    }
}

describe('TagcacheMiddleware with Express', () => {
    let cache: MemoryTagCache;
    let middleware: TagcacheMiddleware;
    let app: Express;
    let close: () => void;
    let base: string;

    const listen = async () => {
        const server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        // Drop keep-alive sockets too, so a later test reusing the port never reaches this server.
        close = () => { server.closeAllConnections(); server.close(); };
    };

    const request = async (path: string, init?: RequestInit) => {
        const res = await fetch(base + path, init);
        return { status: res.status, cache: res.headers.get('x-cache'), body: await res.text() };
    };

    /** Waits for the finish-time cache write of the previous request. */
    const cached = (count: number) => vi.waitFor(() => expect(cache.entries.size).toBe(count));

    beforeEach(() => {
        cache = new MemoryTagCache();
        middleware = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true });
        app = express();
    });

    afterEach(() => close?.());

    it('keeps routers mounted at different paths apart', async () => {
        for (const version of ['v1', 'v2']) {
            const router = express.Router();
            router.get('/users', middleware.cache(['users']), (_req, res) => { res.json({ version }); });
            app.use(`/${version}`, router);
        }
        await listen();

        expect(await request('/v1/users')).toMatchObject({ cache: 'MISS', body: '{"version":"v1"}' });
        await cached(1);
        expect(await request('/v2/users')).toMatchObject({ cache: 'MISS', body: '{"version":"v2"}' });
        await cached(2);
        expect(await request('/v2/users')).toMatchObject({ cache: 'HIT', body: '{"version":"v2"}' });
    });

    it.each([
        ['res.json()', (res: express.Response) => res.json({ a: 1 })],
        ['res.send(object)', (res: express.Response) => res.send({ a: 1 })],
        ['res.send(JSON string)', (res: express.Response) => res.type('json').send('{"a":1}')],
        ['res.send(Buffer)', (res: express.Response) => res.type('json').send(Buffer.from('{"a":1}'))],
    ])('replays a %s body byte for byte', async (_, send) => {
        app.get('/item', middleware.cache(['item']), (_req, res) => { send(res); });
        await listen();

        const miss = await request('/item');
        await cached(1);
        const hit = await request('/item');

        expect(miss).toMatchObject({ cache: 'MISS', body: '{"a":1}' });
        expect(hit).toMatchObject({ cache: 'HIT', body: '{"a":1}' });
    });

    it('stores exactly what Express sent, including json spaces', async () => {
        app.set('json spaces', 2);
        app.get('/item', middleware.cache(['item']), (_req, res) => { res.json({ a: [1, 2] }); });
        await listen();

        const miss = await request('/item');
        await cached(1);

        expect([...cache.entries.values()][0].value).toBe(miss.body);
        expect((await request('/item')).body).toBe(miss.body);
    });

    it('caches under the key computed before the handler changed the request', async () => {
        app.post('/search', express.json(), middleware.cache(['search']), (req, res) => {
            req.body.page = 99;
            res.json({ results: [] });
        });
        await listen();
        const post = () => request('/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"x"}' });

        expect((await post()).cache).toBe('MISS');
        await cached(1);
        expect((await post()).cache).toBe('HIT');
    });

    it.each([
        ['set cookies', (res: express.Response) => res.cookie('sid', '1').json({})],
        ['are Cache-Control: private', (res: express.Response) => res.set('Cache-Control', 'private').json({})],
        ['are not 2xx', (res: express.Response) => res.status(404).json({})],
        ['are 202 Accepted', (res: express.Response) => res.status(202).json({ status: 'processing' })],
        ['are not JSON', (res: express.Response) => res.send('<p>hi</p>')],
    ])('does not cache responses that %s', async (_, send) => {
        app.get('/item', middleware.cache(['item']), (_req, res) => { send(res); });
        await listen();

        await request('/item');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await request('/item')).cache).toBe('MISS');
        expect(cache.entries.size).toBe(0);
    });

    it('does not cache responses that vary by request headers the key ignores', async () => {
        app.get('/doc', middleware.cache(['doc']), (_req, res) => {
            res.format({ 'application/json': () => res.json({ kind: 'json' }), 'text/html': () => res.send('<h1>html</h1>') });
        });
        app.get('/cors', middleware.cache(['cors']), (_req, res) => { res.vary('Origin').vary('Accept-Encoding').json({}); });
        app.get('/lang', middleware.cache(['lang'], { vary: (req) => req.get('accept-language') }), (_req, res) => { res.vary('Accept-Language').json({}); });
        await listen();

        expect(await request('/doc', { headers: { accept: 'application/json' } })).toMatchObject({ cache: 'MISS', body: '{"kind":"json"}' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await request('/doc', { headers: { accept: 'text/html' } })).toMatchObject({ cache: 'MISS', body: '<h1>html</h1>' });
        expect(cache.events.find((e) => e.type === 'store')).toMatchObject({ stored: false, reason: 'vary' });

        await request('/cors');
        await request('/lang');
        await cached(2); // harmless Vary fields, and Vary covered by the route's vary option
    });

    it('keys responses by the vary option', async () => {
        app.get('/me', middleware.cache(['me'], { vary: (req) => req.get('x-user') }), (req, res) => { res.json({ user: req.get('x-user') }); });
        await listen();
        const as = (user: string) => request('/me', { headers: { 'x-user': user } });

        await as('alice');
        await cached(1);
        expect(await as('bob')).toMatchObject({ cache: 'MISS', body: '{"user":"bob"}' });
        await cached(2);
        expect(await as('alice')).toMatchObject({ cache: 'HIT', body: '{"user":"alice"}' });
    });

    it('does not cache a response whose tags were invalidated while the handler ran', async () => {
        let data = 'old';
        app.get('/item', middleware.cache(['item']), async (_req, res) => {
            const snapshot = data;
            await cache.invalidate({ tags: ['item'] }); // a concurrent mutation lands mid-request
            data = 'new';
            res.json({ data: snapshot });
        });
        await listen();

        expect(await request('/item')).toMatchObject({ cache: 'MISS', body: '{"data":"old"}' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(cache.entries.size).toBe(0);
    });

    it('ignores the configured query parameters in the key', async () => {
        app.get('/item', middleware.cache(['item'], { ignoreQuery: ['utm_*'] }), (_req, res) => { res.json({}); });
        await listen();

        await request('/item?id=1&utm_source=mail');
        await cached(1);
        expect((await request('/item?utm_campaign=x&id=1')).cache).toBe('HIT');
        expect((await request('/item?id=2')).cache).toBe('MISS');
    });

    describe('coalesce', () => {
        const slowRoute = (handled: { count: number }, send: (res: express.Response) => void = (res) => res.json({ n: handled.count })) =>
            async (_req: express.Request, res: express.Response) => {
                handled.count++;
                await new Promise((resolve) => setTimeout(resolve, 150));
                send(res);
            };
        const burst = (path: string, n: number) => Promise.all(Array.from({ length: n }, () => request(path)));

        it('runs the route once for concurrent identical misses', async () => {
            const handled = { count: 0 };
            app.get('/item', middleware.cache(['item'], { coalesce: true }), slowRoute(handled));
            await listen();

            const responses = await burst('/item', 10);

            expect(handled.count).toBe(1);
            expect(new Set(responses.map((r) => r.body))).toEqual(new Set(['{"n":1}']));
            expect(responses.filter((r) => r.cache === 'MISS')).toHaveLength(1);
            expect(responses.filter((r) => r.cache === 'HIT')).toHaveLength(9);
        });

        it('stops waiting after timeoutMs and runs the route itself', async () => {
            let runs = 0;
            app.get('/item', middleware.cache(['item'], { coalesce: { timeoutMs: 50 } }), async (_req, res) => {
                const run = ++runs;
                await new Promise((resolve) => setTimeout(resolve, run === 1 ? 400 : 0)); // the first request hangs
                res.json({ run });
            });
            await listen();

            const first = request('/item');
            await new Promise((resolve) => setTimeout(resolve, 10));
            const started = Date.now();
            const second = await request('/item');

            expect(second.body).toBe('{"run":2}');
            expect(Date.now() - started).toBeLessThan(300);
            expect((await first).body).toBe('{"run":1}');
        });

        it('is off by default and can be turned off per route', async () => {
            const handled = { count: 0 };
            const coalescing = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true, coalesce: true });
            app.get('/default', middleware.cache(['a']), slowRoute(handled));
            app.get('/opted-out', coalescing.cache(['b'], { coalesce: false }), slowRoute(handled));
            await listen();

            await burst('/default', 3);
            await burst('/opted-out', 3);
            expect(handled.count).toBe(6);
        });

        it('lets waiters run the route in parallel when the response is not cacheable', async () => {
            const handled = { count: 0 };
            app.get('/item', middleware.cache(['item'], { coalesce: true }), slowRoute(handled, (res) => res.cookie('sid', '1').json({})));
            await listen();

            const started = Date.now();
            await burst('/item', 5);

            expect(handled.count).toBe(5);
            expect(Date.now() - started).toBeLessThan(600); // ~300 ms: one wait, then in parallel (serialized would be 750 ms)
        });

        it('does not hand waiters a response whose tags were invalidated while it ran', async () => {
            let data = 'old';
            app.get('/item', middleware.cache(['item'], { coalesce: true }), async (_req, res) => {
                const snapshot = data;
                await new Promise((resolve) => setTimeout(resolve, 50));
                await cache.invalidate({ tags: ['item'] });
                data = 'new';
                res.json({ data: snapshot });
            });
            await listen();

            const first = request('/item');
            await new Promise((resolve) => setTimeout(resolve, 10));
            const second = await request('/item');

            expect((await first).body).toBe('{"data":"old"}');
            expect(second.body).toBe('{"data":"new"}');
        });
    });

    it('reports bypasses, misses, stores and hits to onEvent with the route', async () => {
        const router = express.Router();
        router.get('/items/:id', middleware.cache(['items']), (req, res) => {
            if (req.params.id === 'big') res.json({ blob: 'x'.repeat(3 * 1024 * 1024) });
            else if (req.params.id === 'private') res.set('Cache-Control', 'private').json({});
            else res.json({ id: req.params.id });
        });
        app.use('/api', router);
        await listen();

        await request('/api/items/1', { headers: { 'cache-control': 'no-cache' } });
        await request('/api/items/1');
        await cached(1);
        await request('/api/items/1');
        await request('/api/items/big');
        await request('/api/items/private');
        await vi.waitFor(() => expect(cache.events.filter((e) => e.type === 'store')).toHaveLength(3));

        const route = '/api/items/:id';
        expect(cache.events.map(({ type, ...rest }) => [type, 'reason' in rest ? rest.reason : 'source' in rest ? rest.source : undefined])).toEqual([
            ['bypass', 'request'],
            ['miss', undefined],
            ['store', undefined],
            ['hit', 'redis'],
            ['miss', undefined],
            ['store', 'too-large'],
            ['miss', undefined],
            ['store', 'not-cacheable'],
        ]);
        expect(cache.events.every((e) => !('route' in e) || e.route === route)).toBe(true);
        expect(cache.events.find((e) => e.type === 'store' && e.stored)).toMatchObject({ bytes: Buffer.byteLength('{"id":"1"}') });
    });

    it('applies per-route ttl, methods, key and skip', async () => {
        app.get('/ttl', middleware.cache(['a'], { ttl: 5 }), (_req, res) => { res.json({}); });
        app.all('/methods', middleware.cache(['b'], { methods: ['get'] }), (req, res) => { res.json({ method: req.method }); });
        app.get(['/key/a', '/key/b'], middleware.cache(['c'], { key: (req) => String(req.query.id) }), (req, res) => { res.json({ path: req.path }); });
        app.get('/skip', middleware.cache(['d'], { skip: (req) => req.query.fresh === '1' }), (_req, res) => { res.json({}); });
        app.get('/skip-throws', middleware.cache(['e'], { skip: () => { throw new Error('bad'); } }), (_req, res) => { res.json({}); });
        await listen();

        await request('/ttl');
        await cached(1);
        expect(cache.stores[0].cacheTtl).toBe(5);

        expect((await request('/methods', { method: 'POST' })).cache).toBe('BYPASS');
        expect((await request('/methods')).cache).toBe('MISS');
        await cached(2);

        await request('/key/a?id=7');
        await cached(3);
        expect(await request('/key/b?id=7')).toMatchObject({ cache: 'HIT', body: '{"path":"/key/a"}' });

        expect((await request('/skip?fresh=1')).cache).toBe('BYPASS');
        expect((await request('/skip')).cache).toBe('MISS');
        expect((await request('/skip-throws')).cache).toBe('BYPASS');
        expect(cache.logger.error).toHaveBeenCalledWith('[TagCache] skip() threw; bypassing the cache:', expect.any(Error));
        expect(cache.events.filter((e) => e.type === 'bypass').map((e) => 'reason' in e && e.reason)).toEqual(['method', 'skipped', 'skipped']);
    });

    it('setEnabled(false) stops caching but keeps invalidating, so re-enabling serves fresh data', async () => {
        let version = 1;
        app.get('/item', middleware.cache(['item']), (_req, res) => { res.json({ version }); });
        app.post('/item', middleware.invalidate(['item']), (_req, res) => { version++; res.json({}); });
        await listen();

        await request('/item');
        await cached(1);
        middleware.setEnabled(false);
        expect(middleware.enabled).toBe(false);
        expect((await request('/item')).cache).toBe('BYPASS');
        await request('/item', { method: 'POST' });
        expect(cache.invalidated).toEqual([['item']]);

        middleware.setEnabled(true);
        expect(await request('/item')).toMatchObject({ cache: 'MISS', body: '{"version":2}' });
    });

    it('setEnabled(true) on a middleware created disabled also turns invalidation on', async () => {
        const off = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: false });
        app.post('/item', off.invalidate(['item']), (_req, res) => { res.json({}); });
        await listen();

        await request('/item', { method: 'POST' });
        expect(cache.invalidated).toEqual([]);
        off.setEnabled(true);
        await request('/item', { method: 'POST' });
        expect(cache.invalidated).toEqual([['item']]);
    });

    describe('authGuard', () => {
        const authed = (path: string) => request(path, { headers: { authorization: 'Bearer x' } });

        it("'skip' bypasses requests with an Authorization header unless the route sets vary or key", async () => {
            const guarded = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true, authGuard: 'skip' });
            app.get('/me', guarded.cache(['me']), (_req, res) => { res.json({}); });
            app.get('/me-vary', guarded.cache(['me'], { vary: (req) => req.get('authorization') }), (_req, res) => { res.json({}); });
            app.get('/public', guarded.cache(['p'], { authGuard: 'off' }), (_req, res) => { res.json({}); });
            await listen();

            expect((await authed('/me')).cache).toBe('BYPASS');
            expect((await request('/me')).cache).toBe('MISS');
            expect((await authed('/me-vary')).cache).toBe('MISS');
            expect((await authed('/public')).cache).toBe('MISS');
            expect(cache.events.find((e) => e.type === 'bypass')).toMatchObject({ reason: 'authorization', route: '/me' });
        });

        it("'warn' caches but warns once per route", async () => {
            const warn = vi.fn();
            (cache.logger as any).warn = warn;
            app.get('/me', middleware.cache(['me'], { authGuard: 'warn' }), (_req, res) => { res.json({}); });
            await listen();

            expect((await authed('/me')).cache).toBe('MISS');
            await authed('/me');
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('/me caches requests with an Authorization header');
        });
    });

    describe('staleWhileRevalidate', () => {
        it('serves the stale entry while one request refreshes it', async () => {
            let version = 1;
            let runs = 0;
            app.get('/item', middleware.cache(['item'], { staleWhileRevalidate: 30 }), async (_req, res) => {
                runs++;
                await new Promise((resolve) => setTimeout(resolve, 100));
                res.json({ version });
            });
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll();
            version = 2;
            runs = 0;

            const responses = await Promise.all(Array.from({ length: 5 }, () => request('/item')));
            expect(runs).toBe(1);
            expect(responses.filter((r) => r.cache === 'MISS')).toEqual([{ status: 200, cache: 'MISS', body: '{"version":2}' }]);
            expect(responses.filter((r) => r.cache === 'STALE').map((r) => r.body)).toEqual(Array(4).fill('{"version":1}'));

            await vi.waitFor(() => expect(cache.leases.size).toBe(0)); // lease released after the refresh
            expect(await request('/item')).toMatchObject({ cache: 'HIT', body: '{"version":2}' });
        });

        it('serves the stale entry to the refreshing request too when the refresh fails', async () => {
            let healthy = true;
            app.get('/item', middleware.cache(['item'], { staleWhileRevalidate: 30 }), (_req, res) => {
                if (healthy) return void res.json({ ok: true });
                res.status(503).json({ error: 'db down' });
            });
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll();
            healthy = false;

            expect(await request('/item')).toMatchObject({ status: 200, cache: 'STALE', body: '{"ok":true}' });
            await vi.waitFor(() => expect(cache.leases.size).toBe(0));
        });

        it('does not serve entries older than the window, nor invalidated ones', async () => {
            app.get('/item', middleware.cache(['item'], { staleWhileRevalidate: 1 }), (_req, res) => { res.json({ ok: true }); });
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll(5000);
            expect((await request('/item')).cache).toBe('MISS');

            await cached(1);
            await cache.invalidate({ tags: ['item'] });
            expect((await request('/item')).cache).toBe('MISS');
        });

        it('takes refresh leases for refreshLeaseMs, defaulting to the constructor setting', async () => {
            const slow = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true, refreshLeaseMs: 30_000 });
            app.get('/a', slow.cache(['a'], { staleWhileRevalidate: 30 }), (_req, res) => { res.json({}); });
            app.get('/b', slow.cache(['b'], { staleWhileRevalidate: 30, refreshLeaseMs: 60_000 }), (_req, res) => { res.json({}); });
            await listen();

            await request('/a');
            await request('/b');
            await cached(2);
            cache.expireAll();
            await request('/a');
            await request('/b');
            expect(cache.leaseTtls).toEqual([30_000, 60_000]);
        });

        it('serves stale when another instance holds the refresh lease', async () => {
            app.get('/item', middleware.cache(['item'], { staleWhileRevalidate: 30 }), (_req, res) => { res.json({ fresh: true }); });
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll();
            const key = [...cache.entries.keys()][0];
            cache.leases.set(key, 'other-instance');

            expect((await request('/item')).cache).toBe('STALE');
        });
    });

    describe('staleIfError', () => {
        const flaky = (failWith: (res: express.Response, next: express.NextFunction) => void) => {
            let calls = 0;
            return (_req: express.Request, res: express.Response, next: express.NextFunction) => {
                if (calls++ === 0) return void res.json({ good: true });
                failWith(res, next);
            };
        };

        it.each([
            ['res.status(500)', (res: express.Response) => void res.status(503).json({ error: 'db down' })],
            ['next(error)', (_res: express.Response, next: express.NextFunction) => next(new Error('db down'))],
        ])('serves the stale entry instead of a 5xx sent with %s', async (_, failWith) => {
            app.get('/item', middleware.cache(['item'], { staleIfError: 30 }), flaky(failWith));
            app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).end('<p>oops</p>'); });
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll();
            const expiresAt = [...cache.entries.values()][0].expiresAt;

            const res = await fetch(base + '/item');
            expect([res.status, res.headers.get('x-cache'), res.headers.get('content-type'), await res.text()])
                .toEqual([200, 'STALE', 'application/json; charset=utf-8', '{"good":true}']);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect([...cache.entries.values()][0].expiresAt).toBe(expiresAt); // nothing was re-stored
        });

        it('lets the error through once the entry is older than the window', async () => {
            app.get('/item', middleware.cache(['item'], { staleIfError: 1 }), flaky((res) => void res.status(500).json({})));
            await listen();

            await request('/item');
            await cached(1);
            cache.expireAll(5000);
            expect((await request('/item')).status).toBe(500);
        });
    });

    describe('earlyRefresh', () => {
        let random: ReturnType<typeof vi.spyOn>;
        beforeEach(() => { random = vi.spyOn(Math, 'random'); });
        afterEach(() => random.mockRestore());

        const route = (state: { version: number; fail?: boolean }) => async (_req: express.Request, res: express.Response) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (state.fail) return void res.status(500).json({});
            res.json({ version: state.version });
        };

        it('refreshes a fresh entry early when XFetch says so, holding the lease', async () => {
            const state = { version: 1 };
            app.get('/item', middleware.cache(['item'], { earlyRefresh: true }), route(state));
            await listen();

            await request('/item');
            await cached(1);
            state.version = 2;

            random.mockReturnValue(0.5); // ln(0.5) * ~20 ms is far from the 180 s expiry
            expect(await request('/item')).toMatchObject({ cache: 'HIT', body: '{"version":1}' });

            random.mockReturnValue(0); // ln(0) = -Infinity: refresh now
            expect(await request('/item')).toMatchObject({ cache: 'MISS', body: '{"version":2}' });
            expect(cache.events.find((e) => e.type === 'refresh')).toMatchObject({ reason: 'early', route: '/item' });
            await vi.waitFor(() => expect(cache.leases.size).toBe(0));

            random.mockReturnValue(0.5);
            expect(await request('/item')).toMatchObject({ cache: 'HIT', body: '{"version":2}' });
        });

        it('serves the cached entry if the early refresh fails, and skips refreshing while another instance holds the lease', async () => {
            const state = { version: 1, fail: false };
            app.get('/item', middleware.cache(['item'], { earlyRefresh: { beta: 2 } }), route(state));
            await listen();

            await request('/item');
            await cached(1);
            random.mockReturnValue(0);

            state.fail = true;
            expect(await request('/item')).toMatchObject({ status: 200, cache: 'HIT', body: '{"version":1}' });

            await vi.waitFor(() => expect(cache.leases.size).toBe(0));
            cache.leases.set([...cache.entries.keys()][0], 'other-instance');
            expect(await request('/item')).toMatchObject({ cache: 'HIT', body: '{"version":1}' });
        });
    });

    describe('verify', () => {
        it('re-computes sampled hits, reports stale entries and replaces them', async () => {
            let version = 1;
            app.get('/item', middleware.cache(['item'], { verify: { sampleRate: 1 } }), (_req, res) => { res.json({ version }); });
            await listen();

            await request('/item');
            await cached(1);
            expect((await request('/item')).cache).toBe('MISS'); // sampled, unchanged
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(cache.events.some((e) => e.type === 'stale-detected')).toBe(false);

            version = 2; // the data changed without an invalidation
            expect(await request('/item')).toMatchObject({ body: '{"version":2}' });
            await vi.waitFor(() => expect(cache.events.find((e) => e.type === 'stale-detected')).toMatchObject({ route: '/item' }));
            expect(cache.logger.error).toHaveBeenCalledWith(expect.stringContaining('Stale cache entry detected on /item'), undefined);
            expect([...cache.entries.values()][0].value).toBe('{"version":2}');
        });

        it('uses compare, and never samples at rate 0', async () => {
            let ts = 0;
            const compare = (a: string, b: string) => JSON.parse(a).id === JSON.parse(b).id;
            app.get('/a', middleware.cache(['a'], { verify: { sampleRate: 1, compare } }), (_req, res) => { res.json({ id: 1, ts: ts++ }); });
            app.get('/b', middleware.cache(['b'], { verify: { sampleRate: 0 } }), (_req, res) => { res.json({ ts: ts++ }); });
            await listen();

            await request('/a');
            await cached(1);
            await request('/a');
            await request('/b');
            await cached(2);
            expect((await request('/b')).cache).toBe('HIT');
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(cache.events.some((e) => e.type === 'stale-detected')).toBe(false);
        });
    });

    it('labels router-level middleware by its mount path, not by URL', async () => {
        const warn = vi.fn();
        (cache.logger as any).warn = warn;
        const users = express.Router();
        users.use(middleware.cache(['users'], { authGuard: 'warn' }));
        users.get('/:id', (req, res) => { res.json({ id: req.params.id }); });
        app.use('/users', users);
        await listen();

        for (let i = 0; i < 5; i++) await request(`/users/${i}`, { headers: { authorization: 'Bearer x' } });
        expect(new Set(cache.events.map((e) => ('route' in e ? e.route : undefined)))).toEqual(new Set(['/users/*']));
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('neither caches nor invalidates with a tag function that returns a Promise', async () => {
        const asyncTag = (async () => 'item') as unknown as () => string;
        app.get('/item', middleware.cache([asyncTag]), (_req, res) => { res.json({}); });
        app.post('/item', middleware.invalidate([asyncTag]), (_req, res) => { res.json({}); });
        await listen();

        expect((await request('/item')).cache).toBeNull();
        await request('/item', { method: 'POST' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(cache.entries.size).toBe(0);
        expect(cache.invalidated).toEqual([]);
        expect(cache.logger.error).toHaveBeenCalledWith('[TagCache] cache() middleware error:', expect.objectContaining({ message: 'Tag functions must return a string, not a Promise.' }));
        expect(cache.logger.error).toHaveBeenCalledWith('[TagCache] invalidate() middleware error:', expect.any(TypeError));
    });

    it('ignores client Cache-Control and Pragma with honorRequestCacheControl: false', async () => {
        const strict = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true, honorRequestCacheControl: false });
        app.get('/item', strict.cache(['item']), (_req, res) => { res.json({}); });
        app.get('/opt-in', strict.cache(['other'], { honorRequestCacheControl: true }), (_req, res) => { res.json({}); });
        await listen();

        await request('/item');
        await cached(1);
        expect((await request('/item', { headers: { 'cache-control': 'no-cache' } })).cache).toBe('HIT');
        expect((await request('/item', { headers: { pragma: 'no-cache' } })).cache).toBe('HIT');
        expect((await request('/opt-in', { headers: { 'cache-control': 'no-store' } })).cache).toBe('BYPASS');
    });

    it('sends X-Cache-Key on hits unless exposeCacheKey is false', async () => {
        const hidden = new TagcacheMiddleware({ tagcache: cache as unknown as TagCache, enable: true, exposeCacheKey: false });
        app.get('/shown', middleware.cache(['a']), (_req, res) => { res.json({}); });
        app.get('/hidden', hidden.cache(['b']), (_req, res) => { res.json({}); });
        await listen();
        const cacheKeyOf = async (path: string) => (await fetch(base + path)).headers.get('x-cache-key');

        await request('/shown');
        await request('/hidden');
        await cached(2);
        expect(await cacheKeyOf('/shown')).toMatch(/^test:c:[0-9a-f]{64}$/);
        expect(await cacheKeyOf('/hidden')).toBeNull();
    });

    it('bypasses the cache when the client sends Cache-Control: no-cache', async () => {
        app.get('/item', middleware.cache(['item']), (_req, res) => { res.json({}); });
        await listen();

        expect((await request('/item', { headers: { 'cache-control': 'no-cache' } })).cache).toBe('BYPASS');
    });

    describe('invalidate()', () => {
        it('finishes invalidating before the client receives the response', async () => {
            cache.invalidateDelayMs = 50;
            app.post('/items', middleware.invalidate(['items']), (_req, res) => { res.json({ ok: true }); });
            await listen();

            const response = await request('/items', { method: 'POST' });
            expect(response.body).toBe('{"ok":true}');
            expect(cache.invalidated).toEqual([['items']]);
        });

        it('never serves pre-mutation data to a read issued right after the mutation', async () => {
            let version = 0;
            app.get('/item', middleware.cache(['item']), (_req, res) => { res.json({ version }); });
            app.post('/item', middleware.invalidate(['item']), (_req, res) => { version++; res.json({ ok: true }); });
            await listen();

            for (let i = 0; i < 20; i++) {
                await request('/item');
                await cached(1);
                await request('/item', { method: 'POST' });
                expect(JSON.parse((await request('/item')).body).version).toBe(version);
                await cached(1);
            }
        });

        it('does not invalidate when the mutation fails', async () => {
            app.post('/items', middleware.invalidate(['items']), (_req, res) => { res.status(500).json({ ok: false }); });
            await listen();

            expect((await request('/items', { method: 'POST' })).status).toBe(500);
            expect(cache.invalidated).toEqual([]);
        });
    });
});
