/**
 * Runs against a real Redis when REDIS_URL is set, e.g.
 *   docker run --rm -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

    describe('with Express', () => {
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
                server.close();
            }
        });
    });
});
