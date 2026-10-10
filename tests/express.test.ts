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
    entries = new Map<string, { value: string; tags: string[] }>();
    versions = new Map<string, number>();
    invalidated: string[][] = [];
    invalidateDelayMs = 0;

    async get({ key, tags }: CacheFetchOptions) {
        const entry = this.entries.get(key);
        return entry && tags.every((tag) => entry.tags.includes(tag)) ? entry.value : null;
    }

    async getTagVersions({ tags }: TagVersionsOptions) {
        return { versions: Object.fromEntries(tags.map((tag) => [tag, String(this.versions.get(tag) ?? 0)])) };
    }

    stores: CacheStoreOptions[] = [];

    async set(options: CacheStoreOptions) {
        const { key, value, tags, ifTagVersions } = options;
        this.stores.push(options);
        if (ifTagVersions && tags.some((tag) => ifTagVersions.versions[tag] !== String(this.versions.get(tag) ?? 0))) return false;
        this.entries.set(key, { value, tags });
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
        close = () => server.close();
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
        ['are not JSON', (res: express.Response) => res.send('<p>hi</p>')],
    ])('does not cache responses that %s', async (_, send) => {
        app.get('/item', middleware.cache(['item']), (_req, res) => { send(res); });
        await listen();

        await request('/item');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await request('/item')).cache).toBe('MISS');
        expect(cache.entries.size).toBe(0);
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
