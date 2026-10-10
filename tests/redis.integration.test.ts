/**
 * Runs against a real Redis when REDIS_URL is set, e.g.
 *   docker run --rm -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagCache, TagcacheMiddleware } from '../src/index.js';

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('TagCache against Redis', () => {
    const redis = createClient({ url: REDIS_URL });
    let appContext: string;
    let tagcache: TagCache;

    const tagKey = (tag: string) => `${appContext}:tagcache:tag:${tag}`;
    const dataKey = (key: string) => `${appContext}:tagcache:data:${key}`;
    const create = (options: Partial<ConstructorParameters<typeof TagCache>[0]> = {}) => new TagCache({ redis, appContext, ...options });

    beforeAll(async () => {
        await redis.connect();
    });

    afterAll(async () => {
        await redis.quit();
    });

    afterEach(async () => {
        const keys = await redis.keys(`${appContext}:*`);
        if (keys.length) await redis.unlink(keys);
    });

    beforeEach(() => {
        appContext = `it-${randomUUID()}`;
        tagcache = create();
    });

    it('round-trips values and checks every requested tag', async () => {
        expect(await tagcache.set({ key: 'user:1', value: '{"id":1}', tags: ['users', 'user:1'] })).toBe(true);

        expect(await tagcache.get({ key: 'USER:1', tags: ['users', 'user:1'] })).toBe('{"id":1}');
        expect(await tagcache.get({ key: 'user:1', tags: ['users', 'user:2'] })).toBeNull();
        expect(await tagcache.isMember({ key: 'user:1', tags: ['users'] })).toBe(true);
    });

    it('round-trips an empty string', async () => {
        await tagcache.set({ key: 'empty', value: '', tags: ['t'] });
        expect(await tagcache.get({ key: 'empty', tags: ['t'] })).toBe('');
    });

    it('soft invalidation hides entries but leaves values to expire', async () => {
        await tagcache.set({ key: 'k', value: 'v', tags: ['a'] });

        expect(await tagcache.invalidate({ tags: ['a'], deleteCacheKeys: false })).toBe(true);
        expect(await tagcache.get({ key: 'k', tags: ['a'] })).toBeNull();
        expect(await redis.exists(dataKey('k'))).toBe(1);
        expect(await redis.exists(tagKey('a'))).toBe(0);
    });

    it('hard invalidation deletes every entry under the tags', async () => {
        for (let i = 0; i < 1500; i++) await tagcache.set({ key: `k${i}`, value: 'v', tags: [i % 2 ? 'odd' : 'even', 'all'] });

        expect(await tagcache.invalidate({ tags: ['all', 'odd'], deleteCacheKeys: true })).toBe(true);
        expect(await redis.keys(`${appContext}:*:data:*`)).toEqual([]);
        expect(await redis.exists([tagKey('all'), tagKey('odd')])).toBe(0);
    });

    it('backgroundPurge hides entries immediately and deletes them afterwards', async () => {
        const cache = create({ backgroundPurge: true });
        for (let i = 0; i < 2500; i++) await cache.set({ key: `k${i}`, value: 'v', tags: ['bulk'] });

        expect(await cache.invalidate({ tags: ['bulk'], deleteCacheKeys: true })).toBe(true);
        expect(await cache.get({ key: 'k1', tags: ['bulk'] })).toBeNull();
        await vi.waitFor(async () => expect(await redis.keys(`${appContext}:*:data:*`)).toEqual([]));
    });

    it('serves expired entries through lookup() for staleTtl, but never invalidated ones', async () => {
        for (const mode of ['strict', 'lazy'] as const) {
            const cache = create({ staleTtl: 5, tagIndexMaintenanceMode: mode });
            await cache.set({ key: `k-${mode}`, value: 'v', tags: [`t-${mode}`], cacheTtl: 1 });
            await new Promise((resolve) => setTimeout(resolve, 1100));

            expect(await cache.get({ key: `k-${mode}`, tags: [`t-${mode}`] })).toBeNull();
            expect(await cache.lookup({ key: `k-${mode}`, tags: [`t-${mode}`] })).toMatchObject({ value: 'v', stale: true });
            expect(await cache.lookup({ key: `k-${mode}`, tags: [`t-${mode}`] })).toMatchObject({ stale: true }); // strict reads did not prune it

            await cache.invalidate({ tags: [`t-${mode}`], deleteCacheKeys: false });
            expect(await cache.lookup({ key: `k-${mode}`, tags: [`t-${mode}`] })).toBeNull();
        }
    });

    it('leases are exclusive across instances until released or expired', async () => {
        const a = create();
        const b = create();
        const token = await a.acquireLease({ key: 'k', ttlMs: 200 });
        expect(token).not.toBeNull();
        expect(await b.acquireLease({ key: 'k' })).toBeNull();
        expect(await b.releaseLease({ key: 'k', token: 'not-mine' })).toBe(false);
        expect(await a.releaseLease({ key: 'k', token: token! })).toBe(true);

        expect(await b.acquireLease({ key: 'k', ttlMs: 100 })).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await a.acquireLease({ key: 'k' })).not.toBeNull();
    });

    it('treats expired index entries as misses in both maintenance modes', async () => {
        for (const mode of ['strict', 'lazy'] as const) {
                const cache = create({ tagIndexMaintenanceMode: mode });
            await redis.set(dataKey('k'), 'still-here');
            await redis.zAdd(tagKey('t'), { score: Date.now() - 1, value: dataKey('k') });

            expect(await cache.get({ key: 'k', tags: ['t'] })).toBeNull();
            expect(await cache.isMember({ key: 'k', tags: ['t'] })).toBe(false);
            expect(await redis.zCard(tagKey('t'))).toBe(mode === 'strict' ? 0 : 1);
        }
    });

    it('prunes expired index entries on write, so lazy mode stays bounded', async () => {
        const lazy = create({ tagIndexMaintenanceMode: 'lazy' });
        const expired = Array.from({ length: 500 }, (_, i) => ({ score: Date.now() - 1, value: dataKey(`old${i}`) }));
        await redis.zAdd(tagKey('hot'), expired);

        await lazy.set({ key: 'new', value: 'v', tags: ['hot'] });
        expect(await redis.zRange(tagKey('hot'), 0, -1)).toEqual([dataKey('new')]);
    });

    it('keeps the tag index alive at least as long as its longest-lived entry', async () => {
        await tagcache.set({ key: 'long', value: 'v', tags: ['t'], cacheTtl: 3600, tagTtl: 60 });
        expect(await redis.ttl(tagKey('t'))).toBeGreaterThan(3500);

        await tagcache.set({ key: 'short', value: 'v', tags: ['t'], cacheTtl: 1, tagTtl: 1 });
        expect(await redis.ttl(tagKey('t'))).toBeGreaterThan(3500);
        expect(await redis.ttl(dataKey('short'))).toBe(1);
    });

    it('rejects a write whose tags were invalidated after the snapshot', async () => {
        const before = await tagcache.getTagVersions({ tags: ['users'] });
        await tagcache.invalidate({ tags: ['users'] });

        expect(await tagcache.set({ key: 'stale', value: 'old', tags: ['users'], ifTagVersions: before! })).toBe(false);
        expect(await redis.exists(dataKey('stale'))).toBe(0);

        const after = await tagcache.getTagVersions({ tags: ['users'] });
        expect(await tagcache.set({ key: 'fresh', value: 'new', tags: ['users'], ifTagVersions: after! })).toBe(true);
        expect(await tagcache.get({ key: 'fresh', tags: ['users'] })).toBe('new');
        expect(await redis.ttl(`${tagKey('users')}:VERSION`)).toBeGreaterThan(0);
    });

    it('rejects a stale write even if the tag version token was evicted', async () => {
        const before = await tagcache.getTagVersions({ tags: ['users'] });
        await tagcache.invalidate({ tags: ['users'] });
        await redis.del(`${tagKey('users')}:VERSION`); // what allkeys-lru eviction or a partial flush would do

        expect(await tagcache.set({ key: 'stale', value: 'old', tags: ['users'], ifTagVersions: before! })).toBe(false);
        expect(await redis.exists(dataKey('stale'))).toBe(0);
    });

    it('refuses writes for fenced tags until replicaLagMs has passed, on every instance', async () => {
        const invalidator = create({ replicaLagMs: 300 });
        const writer = create();
        await invalidator.invalidate({ tags: ['users'] });

        expect(await writer.set({ key: 'k', value: 'from-lagging-replica', tags: ['users', 'other'] })).toBe(false);
        expect(await writer.set({ key: 'unrelated', value: 'v', tags: ['other'] })).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(await writer.set({ key: 'k', value: 'fresh', tags: ['users'] })).toBe(true);
    });

    it('hierarchicalTags: invalidating an ancestor invalidates its descendants, soft or hard', async () => {
        const cache = create({ hierarchicalTags: true });
        await cache.set({ key: 'u7', value: 'user 7', tags: ['tenant:42:users:7'] });
        await cache.set({ key: 'o1', value: 'order 1', tags: ['tenant:42:orders:1'] });
        await cache.set({ key: 'other', value: 'tenant 43', tags: ['tenant:43:users:1'] });

        await cache.invalidate({ tags: ['tenant:42'], deleteCacheKeys: false });
        expect(await cache.get({ key: 'u7', tags: ['tenant:42:users:7'] })).toBeNull();
        expect(await cache.get({ key: 'o1', tags: ['tenant:42:orders:1'] })).toBeNull();
        expect(await cache.get({ key: 'other', tags: ['tenant:43:users:1'] })).toBe('tenant 43');

        const before = await cache.getTagVersions({ tags: ['tenant:43:users:1'] });
        await cache.invalidate({ tags: ['tenant:43'], deleteCacheKeys: true });
        expect(await redis.exists(dataKey('other'))).toBe(0);
        expect(await cache.set({ key: 'other', value: 'stale', tags: ['tenant:43:users:1'], ifTagVersions: before! })).toBe(false);
    });

    it('inspectTag() reports the live entries an invalidation would affect', async () => {
        for (let i = 0; i < 30; i++) await tagcache.set({ key: `k${i}`, value: 'v', tags: ['products'], cacheTtl: 60 });
        await redis.zAdd(tagKey('products'), { score: Date.now() - 1, value: dataKey('expired') });

        const report = await tagcache.inspectTag({ tag: 'Products', limit: 5 });
        expect(report).toMatchObject({ entries: 30, ttl: expect.any(Number) });
        expect(report!.keys).toHaveLength(5);
        expect(report!.keys.every((key) => key.startsWith(`${appContext}:tagcache:data:k`))).toBe(true);
        expect(report!.ttl).toBeGreaterThan(200);
        expect(await tagcache.inspectTag({ tag: 'missing' })).toEqual({ entries: 0, keys: [], ttl: -2 });
    });

    it('version tokens stay compatible with v2.3 instances, which INCR them', async () => {
        const before = await tagcache.getTagVersions({ tags: ['users'] });
        const versionKey = `${tagKey('users')}:VERSION`;
        await expect(redis.incr(versionKey)).resolves.toEqual(expect.any(Number)); // what v2.3 invalidate() does
        expect(await tagcache.set({ key: 'stale', value: 'old', tags: ['users'], ifTagVersions: before! })).toBe(false);

        await tagcache.invalidate({ tags: ['users'] });
        await expect(redis.incr(versionKey)).resolves.toEqual(expect.any(Number));
    });

    it('reloads the script after SCRIPT FLUSH', async () => {
        await redis.scriptFlush();
        expect(await tagcache.set({ key: 'k', value: 'v', tags: ['t'] })).toBe(true);
        expect(await tagcache.get({ key: 'k', tags: ['t'] })).toBe('v');
    });

    it('works across appContexts', async () => {
        const users = tagcache;
        const orders = new TagCache({ redis, appContext: `${appContext}-orders` });
        await users.set({ key: 'u', value: 'v', tags: ['users'] });

        expect(await orders.get({ key: 'u', tags: ['users'], appContext })).toBe('v');
        await orders.invalidate({ tags: ['users'], appContext });
        expect(await users.get({ key: 'u', tags: ['users'] })).toBeNull();
    });

    it('getOrSet() loads once for concurrent misses and caches the result', async () => {
        let loads = 0;
        const load = async () => {
            loads++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return '{"products":[]}';
        };

        const values = await Promise.all(Array.from({ length: 20 }, () => tagcache.getOrSet({ key: 'products', tags: ['products'], load })));

        expect(new Set(values)).toEqual(new Set(['{"products":[]}']));
        expect(loads).toBe(1);
        expect(await tagcache.get({ key: 'products', tags: ['products'] })).toBe('{"products":[]}');
    });

    it('getOrSet() serves stale while one caller refreshes in the background', async () => {
        const cache = create({ staleTtl: 10 });
        await cache.set({ key: 'k', value: 'old', tags: ['t'], cacheTtl: 1 });
        await new Promise((resolve) => setTimeout(resolve, 1100));

        let loads = 0;
        const load = async () => { loads++; await new Promise((r) => setTimeout(r, 50)); return 'new'; };
        const values = await Promise.all(Array.from({ length: 10 }, () => cache.getOrSet({ key: 'k', tags: ['t'], load, staleWhileRevalidate: 10 })));

        expect(new Set(values)).toEqual(new Set(['old']));
        await vi.waitFor(async () => expect(await cache.get({ key: 'k', tags: ['t'] })).toBe('new'));
        expect(loads).toBe(1);
    });

    it('operationTimeout turns a stalled Redis into a fast miss', async () => {
        const admin = redis.duplicate();
        await admin.connect();
        try {
            const cache = create({ operationTimeout: 50, logger: { error: () => undefined } });
            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            await admin.sendCommand(['CLIENT', 'PAUSE', '400', 'ALL']);

            const started = Date.now();
            expect(await cache.get({ key: 'k', tags: ['t'] })).toBeNull();
            expect(Date.now() - started).toBeLessThan(300);

            await new Promise((resolve) => setTimeout(resolve, 450));
            expect(await cache.get({ key: 'k', tags: ['t'] })).toBe('v');
        } finally {
            await admin.quit();
        }
    });

    it('retryInvalidations replays an invalidation that failed while Redis was unreachable', async () => {
        const admin = redis.duplicate();
        await admin.connect();
        try {
            const cache = create({ retryInvalidations: true, operationTimeout: 50, logger: { error: () => undefined } });
            await cache.set({ key: 'k', value: 'old', tags: ['users'] });
            await admin.sendCommand(['CLIENT', 'PAUSE', '300', 'ALL']);

            expect(await cache.invalidate({ tags: ['users'] })).toBe(false);
            expect(await cache.get({ key: 'k', tags: ['users'] })).toBeNull(); // blocked locally, not served stale

            await new Promise((resolve) => setTimeout(resolve, 350));
            expect(await cache.flushInvalidations()).toBe(true);
            expect(await redis.exists(dataKey('k'))).toBe(0);
        } finally {
            await admin.quit();
        }
    });

    describe('with Express', () => {
        const serve = async (app: express.Express) => {
            const server = app.listen(0);
            await new Promise((resolve) => server.once('listening', resolve));
            return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); server.close(); } };
        };

        it.each([
            ['default settings', {}, {}, {}],
            [
                'every feature enabled',
                { staleTtl: 5, hierarchicalTags: true, backgroundPurge: true, deleteCacheKeys: false, replicaLagMs: 5, tagIndexMaintenanceMode: 'lazy' as const },
                { coalesce: true },
                { ttl: 1, staleWhileRevalidate: 5, earlyRefresh: true },
            ],
        ])('never serves a read older than the last acknowledged write (%s)', async (_, cacheOptions, middlewareOptions, routeOptions) => {
            const db = [0, 0, 0, 0, 0];
            const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            const instances = await Promise.all([0, 1].map(() => {
                const middleware = new TagcacheMiddleware({ tagcache: create(cacheOptions), enable: true, ...middlewareOptions });
                const app = express();
                app.get('/items/:id', middleware.cache([(req) => `items:${req.params.id}`], routeOptions), async (req, res) => {
                    const version = db[Number(req.params.id)];
                    await sleep(Math.random() * 15); // a slow read: writes land in between
                    res.json({ version });
                });
                app.post('/items/:id', middleware.invalidate([(req) => `items:${req.params.id}`]), (req, res) => {
                    const version = ++db[Number(req.params.id)];
                    res.json({ version });
                });
                return serve(app);
            }));

            const acknowledged = [0, 0, 0, 0, 0];
            const violations: string[] = [];
            let reads = 0;
            const deadline = Date.now() + 2500;
            const worker = async () => {
                while (Date.now() < deadline) {
                    const id = Math.floor(Math.random() * db.length);
                    const { base } = instances[Math.floor(Math.random() * 2)];
                    if (Math.random() < 0.2) {
                        const { version } = (await fetch(`${base}/items/${id}`, { method: 'POST' }).then((r) => r.json())) as { version: number };
                        acknowledged[id] = Math.max(acknowledged[id], version);
                    } else {
                        const floor = acknowledged[id];
                        const res = await fetch(`${base}/items/${id}`);
                        const { version } = (await res.json()) as { version: number };
                        reads++;
                        if (version < floor) violations.push(`item ${id}: read v${version} after v${floor} was acknowledged (${res.headers.get('x-cache')})`);
                    }
                }
            };
            try {
                await Promise.all(Array.from({ length: 20 }, worker));
            } finally {
                instances.forEach((instance) => instance.close());
            }

            expect(reads).toBeGreaterThan(300);
            expect(violations).toEqual([]);
        }, 15_000);

        it('staleWhileRevalidate refreshes once across instances while the rest are served stale', async () => {
            let runs = 0;
            const instances = await Promise.all([0, 1].map(() => {
                const middleware = new TagcacheMiddleware({ tagcache: create({ staleTtl: 10 }), enable: true });
                const app = express();
                app.get('/item', middleware.cache(['item'], { ttl: 1, staleWhileRevalidate: 10 }), async (_req, res) => {
                    runs++;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    res.json({ runs });
                });
                return serve(app);
            }));
            try {
                await fetch(`${instances[0].base}/item`).then((r) => r.text());
                await new Promise((resolve) => setTimeout(resolve, 1100)); // let it expire
                runs = 0;

                const responses = await Promise.all(Array.from({ length: 10 }, (_, i) =>
                    fetch(`${instances[i % 2].base}/item`).then(async (r) => [r.headers.get('x-cache'), await r.text()])));

                expect(runs).toBe(1);
                expect(responses.filter(([cache]) => cache === 'STALE')).toHaveLength(9);
            } finally {
                instances.forEach((instance) => instance.close());
            }
        });

        it('never serves a stale read right after a mutation', async () => {
                const middleware = new TagcacheMiddleware({ tagcache, enable: true });
            let version = 0;
            const app = express();
            app.get('/item', middleware.cache(['item']), (_req, res) => { res.json({ version }); });
            app.post('/item', middleware.invalidate(['item']), (_req, res) => { version++; res.json({ ok: true }); });
            const server = app.listen(0);
            await new Promise((resolve) => server.once('listening', resolve));
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

            try {
                let stale = 0;
                for (let i = 0; i < 100; i++) {
                    await fetch(`${base}/item`).then((r) => r.text());
                    await new Promise((resolve) => setTimeout(resolve, 5)); // let the cache write land
                    await fetch(`${base}/item`, { method: 'POST' }).then((r) => r.text());
                    const body = (await fetch(`${base}/item`).then((r) => r.json())) as { version: number };
                    if (body.version !== version) stale++;
                }
                expect(stale).toBe(0);
            } finally {
                server.closeAllConnections();
                server.close();
            }
        });
    });
});
