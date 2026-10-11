import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { TagCache } from '../src/tagcache.js';
import { createMockRedis, future, past } from './helpers.js';

describe('TagCache', () => {
    let mock: ReturnType<typeof createMockRedis>;
    let logger: { error: Mock<(message: string, error?: unknown) => void> };
    let tagCache: TagCache;

    const create = (options: Record<string, unknown> = {}) =>
        new TagCache({ redis: mock.redis, appContext: 'test-app', cachePrefix: 'c:', tagPrefix: 't:', logger, ...options });

    beforeEach(() => {
        mock = createMockRedis();
        logger = { error: vi.fn<(message: string, error?: unknown) => void>() };
        tagCache = create();
    });

    describe('constructor', () => {
        it('applies provided options', () => {
            expect(tagCache.cacheOptions).toMatchObject({ appContext: 'test-app', cachePrefix: 'c:', tagPrefix: 't:' });
        });

        it('applies defaults', () => {
            expect(new TagCache({ redis: mock.redis }).cacheOptions).toEqual({
                tagPrefix: 'tagcache:tag:',
                cachePrefix: 'tagcache:data:',
                tagTtl: 240,
                cacheTtl: 180,
                appContext: 'tagcache',
                sizeGuard: 2048,
                deleteCacheKeys: true,
                tagIndexMaintenanceMode: 'strict',
            });
        });

        it('throws if redis is missing', () => {
            // @ts-expect-error testing invalid input
            expect(() => new TagCache({})).toThrow('[TagCache] A Redis client instance is required.');
        });

        it.each([0, -1, 1.5, Number.NaN, Infinity])('falls back to default TTLs for invalid value %s', (ttl) => {
            const options = create({ cacheTtl: ttl, tagTtl: ttl }).cacheOptions;
            expect(options.cacheTtl).toBe(180);
            expect(options.tagTtl).toBe(240);
        });

        it.each([0, -5, Number.NaN])('falls back to default sizeGuard for invalid value %s', (sizeGuard) => {
            expect(create({ sizeGuard }).cacheOptions.sizeGuard).toBe(2048);
        });

        it('accepts a fractional sizeGuard', () => {
            expect(create({ sizeGuard: 0.5 }).cacheOptions.sizeGuard).toBe(0.5);
        });

        it('treats unknown tagIndexMaintenanceMode values as strict', () => {
            expect(create({ tagIndexMaintenanceMode: 'LAZY' }).cacheOptions.tagIndexMaintenanceMode).toBe('strict');
            expect(create({ tagIndexMaintenanceMode: 'lazy' }).cacheOptions.tagIndexMaintenanceMode).toBe('lazy');
        });

        it('defaults the logger to console', () => {
            expect(new TagCache({ redis: mock.redis }).logger).toBe(console);
        });
    });

    describe('get', () => {
        it('returns null when the value is missing', async () => {
            mock.queueExec([null, 0, future()]);
            expect(await tagCache.get({ key: 'key1', tags: ['tag1'] })).toBeNull();
        });

        it('returns the value when it belongs to every tag, pruning in strict mode', async () => {
            mock.queueExec(['cached-data', 0, future(), 0, future()]);

            expect(await tagCache.get({ key: 'key1', tags: ['tag1', 'tag2'] })).toBe('cached-data');
            expect(mock.batches[0].commands).toEqual([
                ['get', 'test-app:c:key1'],
                ['zRemRangeByScore', 'test-app:t:tag1', 0, expect.any(Number)],
                ['zScore', 'test-app:t:tag1', 'test-app:c:key1'],
                ['zRemRangeByScore', 'test-app:t:tag2', 0, expect.any(Number)],
                ['zScore', 'test-app:t:tag2', 'test-app:c:key1'],
            ]);
        });

        it('returns null when any tag no longer contains the key', async () => {
            mock.queueExec(['cached-data', 0, future(), 0, null]);
            expect(await tagCache.get({ key: 'key1', tags: ['tag1', 'tag2'] })).toBeNull();
        });

        it('returns null for an expired index entry in lazy mode, without pruning', async () => {
            mock.queueExec(['cached-data', past()]);

            expect(await create({ tagIndexMaintenanceMode: 'lazy' }).get({ key: 'key1', tags: ['tag1'] })).toBeNull();
            expect(mock.batches[0].commands).toEqual([
                ['get', 'test-app:c:key1'],
                ['zScore', 'test-app:t:tag1', 'test-app:c:key1'],
            ]);
        });

        it('returns a stored empty string instead of treating it as a miss', async () => {
            mock.queueExec(['', 0, future()]);
            expect(await tagCache.get({ key: 'key1', tags: ['tag1'] })).toBe('');
        });

        it('reads from the given appContext', async () => {
            mock.queueExec(['cached-data', 0, future()]);

            await tagCache.get({ key: 'key1', tags: ['tag1'], appContext: 'other-service' });
            expect(mock.batches[0].commands).toContainEqual(['get', 'other-service:c:key1']);
            expect(mock.batches[0].commands).toContainEqual(['zScore', 'other-service:t:tag1', 'other-service:c:key1']);
        });

        it('returns null and logs when redis is not ready', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.get({ key: 'key1', tags: ['tag1'] })).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('[TagCache] get() failed:', expect.any(Error));
        });

        it('returns null and logs for invalid tags', async () => {
            expect(await tagCache.get({ key: 'key1', tags: [] })).toBeNull();
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('set', () => {
        it('writes through the set script with keys and arguments', async () => {
            const before = Date.now();
            expect(await tagCache.set({ key: 'Key1', value: 'val1', tags: ['tag1', 'TAG1', 'tag2'], cacheTtl: 100, tagTtl: 200 })).toBe(true);

            const [sha, { keys, arguments: args }] = mock.redis.evalSha.mock.calls[0];
            expect(sha).toMatch(/^[0-9a-f]{40}$/);
            expect(keys).toEqual(['test-app:c:key1', 'test-app:t:tag1', 'test-app:t:tag2', 'test-app:t:tag1:FENCE', 'test-app:t:tag2:FENCE']);
            expect(args.slice(0, 3)).toEqual(['val1', '100', '200000']);
            expect(Number(args[3])).toBeGreaterThanOrEqual(before);
            expect(Number(args[4])).toBe(Number(args[3]) + 100_000);
            expect(args.slice(5)).toEqual(['2']);
        });

        it('keeps tag indexes alive at least as long as the entry', async () => {
            await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], cacheTtl: 600, tagTtl: 60 });
            const { arguments: args } = mock.redis.evalSha.mock.calls[0][1];
            expect(args[1]).toBe('600');
            expect(args[2]).toBe('600000');
        });

        it('falls back to instance TTLs for invalid overrides', async () => {
            await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], cacheTtl: 1.5, tagTtl: -1 });
            const { arguments: args } = mock.redis.evalSha.mock.calls[0][1];
            expect(args.slice(1, 3)).toEqual(['180', '240000']);
        });

        it('spreads TTLs by ttlJitter', async () => {
            const random = vi.spyOn(Math, 'random');
            try {
                const cache = create({ ttlJitter: 0.1, tagTtl: 1 });
                const ttls: string[] = [];
                for (const r of [0, 0.5, 0.9999]) {
                    random.mockReturnValueOnce(r);
                    await cache.set({ key: 'k', value: 'v', tags: ['t'], cacheTtl: 100 });
                    const { arguments: args } = mock.redis.evalSha.mock.calls.at(-1)![1];
                    ttls.push(args[1]);
                    expect(args[2]).toBe(String(Number(args[1]) * 1000)); // the index outlives the jittered entry
                }
                expect(ttls).toEqual(['90', '100', '110']);
            } finally {
                random.mockRestore();
            }
        });

        it.each([0, 1, -0.2, Number.NaN])('ignores invalid ttlJitter %s', async (ttlJitter) => {
            await create({ ttlJitter }).set({ key: 'k', value: 'v', tags: ['t'], cacheTtl: 100 });
            expect(mock.redis.evalSha.mock.calls[0][1].arguments[1]).toBe('100');
        });

        it('falls back to EVAL when the script is not cached', async () => {
            mock.redis.evalSha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script.'));

            expect(await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'] })).toBe(true);
            expect(mock.redis.eval).toHaveBeenCalledWith(expect.stringContaining('ZADD'), mock.redis.evalSha.mock.calls[0][1]);
        });

        it('returns false and logs on other script errors', async () => {
            mock.redis.evalSha.mockRejectedValueOnce(new Error('WRONGTYPE'));

            expect(await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'] })).toBe(false);
            expect(mock.redis.eval).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith('[TagCache] set() failed:', expect.any(Error));
        });

        it('passes snapshotted tag versions for the script to verify', async () => {
            const ifTagVersions = { versions: { 'test-app:t:tag1:VERSION': '3', 'test-app:t:other:VERSION': '9' } };

            await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1', 'tag2'], ifTagVersions });

            const { keys, arguments: args } = mock.redis.evalSha.mock.calls[0][1];
            expect(keys).toEqual(['test-app:c:key1', 'test-app:t:tag1', 'test-app:t:tag2', 'test-app:t:tag1:FENCE', 'test-app:t:tag2:FENCE', 'test-app:t:tag1:VERSION']);
            expect(args.slice(5)).toEqual(['2', '3']);
        });

        it('returns false while a tag is fenced', async () => {
            mock.redis.evalSha.mockResolvedValueOnce(2);
            expect(await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'] })).toBe(false);
            expect(logger.error).not.toHaveBeenCalled();
        });

        it('returns false when the script skips the write', async () => {
            mock.redis.evalSha.mockResolvedValueOnce(0);
            expect(await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], ifTagVersions: { versions: {} } })).toBe(false);
            expect(logger.error).not.toHaveBeenCalled();
        });

        it('writes to the given appContext', async () => {
            await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], appContext: 'other' });
            const { keys } = mock.redis.evalSha.mock.calls[0][1];
            expect(keys).toEqual(['other:c:key1', 'other:t:tag1', 'other:t:tag1:FENCE']);
        });

        it('returns false when redis is not ready', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.set({ key: 'key1', value: 'val', tags: ['tag1'] })).toBe(false);
        });
    });

    describe('invalidate', () => {
        it('soft-invalidates in a single round trip without reading tag members', async () => {
            expect(await tagCache.invalidate({ tags: ['tag1', 'tag2'], deleteCacheKeys: false })).toBe(true);

            expect(mock.batches).toHaveLength(1);
            expect(mock.batches[0].commands).toEqual([
                ['unlink', ['test-app:t:tag1', 'test-app:t:tag2']],
                ['set', 'test-app:t:tag1:VERSION', expect.stringMatching(/^\d+$/), { EX: 240 }],
                ['set', 'test-app:t:tag2:VERSION', expect.stringMatching(/^\d+$/), { EX: 240 }],
            ]);
        });

        it('hard-invalidates by reading and deleting tag indexes atomically, then deleting entries', async () => {
            mock.queueExec([['k1', 'k2'], ['k2', 'k3'], 2, 1, 1, 1, 1]);

            expect(await tagCache.invalidate({ tags: ['tag1', 'tag2'], deleteCacheKeys: true })).toBe(true);

            expect(mock.batches[0].commands.slice(0, 3)).toEqual([
                ['zRange', 'test-app:t:tag1', 0, -1],
                ['zRange', 'test-app:t:tag2', 0, -1],
                ['unlink', ['test-app:t:tag1', 'test-app:t:tag2']],
            ]);
            expect(mock.batches[1].commands).toEqual([['unlink', ['k1', 'k2', 'k3']]]);
        });

        it('deletes entries in batches of 1000 keys', async () => {
            const members = Array.from({ length: 2500 }, (_, i) => `k${i}`);
            mock.queueExec([members, 1, 1, 1]);

            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: true });

            expect(mock.batches[1].commands.map(([, keys]) => (keys as string[]).length)).toEqual([1000, 1000, 500]);
        });

        it('with backgroundPurge, resolves after invalidating the tags and deletes entries afterwards', async () => {
            const cache = create({ backgroundPurge: true });
            const members = Array.from({ length: 1500 }, (_, i) => `k${i}`);
            mock.queueExec([members, 1, 'OK']);
            let release!: () => void;
            mock.redis.unlink.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(1000); }));

            expect(await cache.invalidate({ tags: ['tag1'], deleteCacheKeys: true })).toBe(true);
            expect(mock.batches).toHaveLength(1); // no foreground delete round trip

            await vi.waitFor(() => expect(mock.redis.unlink).toHaveBeenCalledTimes(1));
            expect(mock.redis.unlink.mock.calls[0][0]).toHaveLength(1000);
            release();
            await vi.waitFor(() => expect(mock.redis.unlink).toHaveBeenCalledTimes(2));
            expect(mock.redis.unlink.mock.calls[1][0]).toHaveLength(500);
        });

        it('skips the delete round trip when the tags had no members', async () => {
            mock.queueExec([[], 0, 1, 1]);
            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: true });
            expect(mock.batches).toHaveLength(1);
        });

        it('defaults to the instance deleteCacheKeys', async () => {
            mock.queueExec([['k1'], 1, 1, 1]);
            await tagCache.invalidate({ tags: ['tag1'] });
            expect(mock.batches[1].commands).toEqual([['unlink', ['k1']]]);

            await create({ deleteCacheKeys: false }).invalidate({ tags: ['tag1'] });
            expect(mock.batches[2].commands[0]).toEqual(['unlink', ['test-app:t:tag1']]);
            expect(mock.batches).toHaveLength(3);
        });

        it('keeps version tokens for max(tagTtl, cacheTtl)', async () => {
            await create({ cacheTtl: 900, tagTtl: 60 }).invalidate({ tags: ['tag1'], deleteCacheKeys: false });
            expect(mock.batches[0].commands).toContainEqual(['set', 'test-app:t:tag1:VERSION', expect.any(String), { EX: 900 }]);
        });

        it('fences the tags for replicaLagMs', async () => {
            await create({ replicaLagMs: 250 }).invalidate({ tags: ['tag1'], deleteCacheKeys: false });
            expect(mock.batches[0].commands).toContainEqual(['set', 'test-app:t:tag1:FENCE', '1', { PX: 250 }]);

            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: false });
            expect(mock.batches[1].commands.some(([, key]) => String(key).endsWith(':FENCE'))).toBe(false);
        });

        it('targets the given appContext', async () => {
            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: false, appContext: 'other' });
            expect(mock.batches[0].commands[0]).toEqual(['unlink', ['other:t:tag1']]);
        });

        it('returns false when redis is not ready', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.invalidate({ tags: ['tag1'] })).toBe(false);
        });
    });

    describe('hierarchicalTags', () => {
        it('indexes, checks and snapshots ancestor tags, but invalidates only the given tags', async () => {
            const cache = create({ hierarchicalTags: true });
            const indexKeys = ['test-app:t:tenant:42:users', 'test-app:t:tenant', 'test-app:t:tenant:42'];

            await cache.set({ key: 'k', value: 'v', tags: ['Tenant:42:Users'] });
            expect(mock.redis.evalSha.mock.calls[0][1].keys.slice(1, 4)).toEqual(indexKeys);

            mock.queueExec(['v', 0, future(), 0, future(), 0, future()]);
            expect(await cache.get({ key: 'k', tags: ['tenant:42:users'] })).toBe('v');
            expect(mock.batches[0].commands.filter(([name]) => name === 'zScore').map(([, key]) => key)).toEqual(indexKeys);

            const versions = await cache.getTagVersions({ tags: ['tenant:42:users'] });
            expect(Object.keys(versions!.versions)).toEqual(indexKeys.map((key) => `${key}:VERSION`));

            await cache.invalidate({ tags: ['tenant:42'], deleteCacheKeys: false });
            expect(mock.batches[2].commands[0]).toEqual(['unlink', ['test-app:t:tenant:42']]);
        });

        it('accepts a custom separator', async () => {
            await create({ hierarchicalTags: { separator: '/' } }).set({ key: 'k', value: 'v', tags: ['a/b'] });
            expect(mock.redis.evalSha.mock.calls[0][1].keys.slice(1, 3)).toEqual(['test-app:t:a/b', 'test-app:t:a']);
        });
    });

    describe('staleTtl and lookup', () => {
        it('keeps entries for staleTtl past expiry and prunes only beyond it', async () => {
            const before = Date.now();
            await create({ staleTtl: 30, tagTtl: 1 }).set({ key: 'k', value: 'v', tags: ['t'], cacheTtl: 60 });

            const args = mock.redis.evalSha.mock.calls[0][1].arguments;
            expect(args.slice(1, 3)).toEqual(['90', '90000']); // value and index retained for cacheTtl + staleTtl
            expect(Number(args[3])).toBeLessThanOrEqual(Date.now() - 30_000); // prune bound
            expect(Number(args[3])).toBeGreaterThanOrEqual(before - 30_000);
            expect(Number(args[4]) - Number(args[3])).toBe(90_000); // expiry stays at cacheTtl
        });

        it('lookup() returns stale entries within staleTtl; get() does not', async () => {
            const cache = create({ staleTtl: 30, tagIndexMaintenanceMode: 'lazy' });
            const expiredAt = Date.now() - 10_000;

            mock.queueExec(['v', expiredAt], ['v', expiredAt]);
            expect(await cache.lookup({ key: 'k', tags: ['t'] })).toEqual({ value: 'v', expiresAt: expiredAt, stale: true });
            expect(await cache.get({ key: 'k', tags: ['t'] })).toBeNull();

            const fresh = future();
            mock.queueExec(['v', fresh]);
            expect(await cache.lookup({ key: 'k', tags: ['t'] })).toEqual({ value: 'v', expiresAt: fresh, stale: false });

            mock.queueExec(['v', Date.now() - 31_000], ['v', expiredAt, null]);
            expect(await cache.lookup({ key: 'k', tags: ['t'] })).toBeNull(); // beyond staleTtl
            expect(await cache.lookup({ key: 'k', tags: ['t', 'gone'] })).toBeNull(); // invalidated tag
        });

        it('prunes strict-mode indexes only beyond staleTtl', async () => {
            mock.queueExec(['v', 0, future()]);
            await create({ staleTtl: 30 }).lookup({ key: 'k', tags: ['t'] });
            const [, , , upTo] = mock.batches[0].commands[1];
            expect(Number(upTo)).toBeLessThanOrEqual(Date.now() - 30_000);
        });
    });

    describe('leases', () => {
        it('acquires with SET NX PX and returns a token, or null when taken', async () => {
            const token = await tagCache.acquireLease({ key: 'K', ttlMs: 500 });
            expect(token).toMatch(/^[\w-]{12}$/);
            expect(mock.redis.set).toHaveBeenCalledWith('test-app:c:k:LEASE', token, { NX: true, PX: 500 });

            mock.redis.set.mockResolvedValueOnce(null);
            expect(await tagCache.acquireLease({ key: 'k' })).toBeNull();
            expect(mock.redis.set.mock.calls[1][2]).toEqual({ NX: true, PX: 10_000 });
        });

        it('releases only with the matching token', async () => {
            mock.redis.evalSha.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
            expect(await tagCache.releaseLease({ key: 'k', token: 'mine' })).toBe(true);
            expect(await tagCache.releaseLease({ key: 'k', token: 'stale' })).toBe(false);
            expect(mock.redis.evalSha.mock.calls[0][1]).toEqual({ keys: ['test-app:c:k:LEASE'], arguments: ['mine'] });
        });
    });

    describe('isMember', () => {
        it('returns true when the key belongs to every tag', async () => {
            mock.queueExec([0, future(), 0, future()]);

            expect(await tagCache.isMember({ key: 'key1', tags: ['tag1', 'tag2'] })).toBe(true);
            expect(mock.batches[0].commands).toEqual([
                ['zRemRangeByScore', 'test-app:t:tag1', 0, expect.any(Number)],
                ['zScore', 'test-app:t:tag1', 'test-app:c:key1'],
                ['zRemRangeByScore', 'test-app:t:tag2', 0, expect.any(Number)],
                ['zScore', 'test-app:t:tag2', 'test-app:c:key1'],
            ]);
        });

        it('returns false when the key is missing from a tag', async () => {
            mock.queueExec([0, future(), 0, null]);
            expect(await tagCache.isMember({ key: 'key1', tags: ['tag1', 'tag2'] })).toBe(false);
        });

        it('returns false for an expired entry in lazy mode', async () => {
            mock.queueExec([past()]);
            expect(await create({ tagIndexMaintenanceMode: 'lazy' }).isMember({ key: 'key1', tags: ['tag1'] })).toBe(false);
            expect(mock.batches[0].commands).toEqual([['zScore', 'test-app:t:tag1', 'test-app:c:key1']]);
        });

        it('returns false if exec returns empty', async () => {
            mock.queueExec([]);
            expect(await tagCache.isMember({ key: 'key1', tags: ['tag1'] })).toBe(false);
        });

        it('returns false when redis is not ready', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.isMember({ key: 'key1', tags: ['tag1'] })).toBe(false);
        });
    });

    describe('delete', () => {
        it('unlinks a single key', async () => {
            expect(await tagCache.delete({ key: 'key1' })).toBe(true);
            expect(mock.redis.unlink).toHaveBeenCalledWith('test-app:c:key1');
        });

        it('targets the given appContext', async () => {
            await tagCache.delete({ key: 'key1', appContext: 'other' });
            expect(mock.redis.unlink).toHaveBeenCalledWith('other:c:key1');
        });

        it('returns false when redis is not ready', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.delete({ key: 'key1' })).toBe(false);
        });
    });

    describe('operationTimeout', () => {
        const hangingExec = (rejectAfterMs?: number) => {
            mock.redis.multi.mockImplementationOnce(() => {
                const batch: any = { get: () => batch, zRemRangeByScore: () => batch, zScore: () => batch };
                batch.exec = () => new Promise((_, reject) => {
                    if (rejectAfterMs !== undefined) setTimeout(() => reject(new Error('late failure')), rejectAfterMs);
                });
                return batch;
            });
        };

        it('gives up on slow operations and logs a timeout', async () => {
            hangingExec(40);
            const started = Date.now();

            expect(await create({ operationTimeout: 20 }).get({ key: 'k', tags: ['t'] })).toBeNull();
            expect(Date.now() - started).toBeLessThan(200);
            expect(logger.error).toHaveBeenCalledWith('[TagCache] get() failed:', expect.objectContaining({ message: 'Redis operation timed out after 20ms' }));
            await new Promise((resolve) => setTimeout(resolve, 40)); // the late rejection must not surface as unhandled
        });

        it.each([0, -1, Number.NaN])('ignores invalid timeout %s', async (operationTimeout) => {
            mock.queueExec(['v', 0, future()]);
            mock.redis.multi.mockImplementationOnce(() => {
                const batch: any = { get: () => batch, zRemRangeByScore: () => batch, zScore: () => batch };
                batch.exec = () => new Promise((resolve) => setTimeout(() => resolve(['v', 0, future()]), 30));
                return batch;
            });
            expect(await create({ operationTimeout }).get({ key: 'k', tags: ['t'] })).toBe('v');
        });
    });

    describe('getOrSet', () => {
        const deferred = () => {
            let resolve!: (value: string) => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
            return { promise, resolve, reject };
        };

        it('returns the cached value without loading', async () => {
            mock.queueExec(['cached', 0, future()]);
            const load = vi.fn(async () => 'fresh');

            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load })).toBe('cached');
            expect(load).not.toHaveBeenCalled();
        });

        it('loads on a miss and writes guarded by a version snapshot', async () => {
            mock.queueExec([null, 0, null], [null, '7']);

            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load: () => 'fresh', cacheTtl: 60 })).toBe('fresh');

            const { keys, arguments: args } = mock.redis.evalSha.mock.calls[0][1];
            expect(keys).toEqual(['test-app:c:k', 'test-app:t:t', 'test-app:t:t:FENCE', 'test-app:t:t:VERSION']);
            expect([args[0], args[1], args[6]]).toEqual(['fresh', '60', '7']);
        });

        it('shares one load between concurrent misses', async () => {
            mock.queueExec([null, 0, null], [null, 0, null]);
            const pending = deferred();
            const load = vi.fn(() => pending.promise);

            const calls = [tagCache.getOrSet({ key: 'k', tags: ['t'], load }), tagCache.getOrSet({ key: 'K ', tags: ['t'], load })];
            await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
            pending.resolve('fresh');

            expect(await Promise.all(calls)).toEqual(['fresh', 'fresh']);
            expect(load).toHaveBeenCalledTimes(1);
        });

        it('makes waiters load again when the shared result could not be cached', async () => {
            mock.queueExec([null, 0, null], [null, 0, null]);
            mock.redis.evalSha.mockResolvedValueOnce(0); // a tag was invalidated during the first load
            const first = deferred();
            const loads = [vi.fn(() => first.promise), vi.fn(async () => 'second')];

            const calls = [tagCache.getOrSet({ key: 'k', tags: ['t'], load: loads[0] }), tagCache.getOrSet({ key: 'k', tags: ['t'], load: loads[1] })];
            await vi.waitFor(() => expect(loads[0]).toHaveBeenCalled());
            first.resolve('first');

            expect(await Promise.all(calls)).toEqual(['first', 'second']);
        });

        it('passes a load failure to every caller sharing it, then retries on the next call', async () => {
            mock.queueExec([null, 0, null], [null, 0, null], [null, 0, null]);
            const pending = deferred();
            const load = vi.fn(() => pending.promise);

            const calls = [tagCache.getOrSet({ key: 'k', tags: ['t'], load }), tagCache.getOrSet({ key: 'k', tags: ['t'], load })];
            await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
            pending.reject(new Error('db down'));

            for (const call of calls) await expect(call).rejects.toThrow('db down');
            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load: () => 'recovered' })).toBe('recovered');
        });

        describe('with stale values', () => {
            const expired = () => Date.now() - 5_000;
            const lazy = () => create({ staleTtl: 60, tagIndexMaintenanceMode: 'lazy' });

            it('staleWhileRevalidate returns the stale value at once and refreshes it in the background', async () => {
                mock.queueExec(['old', expired()]);
                const pending = deferred();
                const load = vi.fn(() => pending.promise);

                expect(await lazy().getOrSet({ key: 'k', tags: ['t'], load, staleWhileRevalidate: 30 })).toBe('old');
                await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
                expect(mock.redis.set).toHaveBeenCalledWith('test-app:c:k:LEASE', expect.any(String), { NX: true, PX: 10_000 });

                pending.resolve('new');
                await vi.waitFor(() => expect(mock.redis.evalSha).toHaveBeenCalledTimes(2)); // set + lease release
                expect(mock.redis.evalSha.mock.calls[0][1].arguments[0]).toBe('new');
            });

            it('holds the refresh lease for refreshLeaseMs', async () => {
                mock.queueExec(['old', expired()]);
                await lazy().getOrSet({ key: 'k', tags: ['t'], load: async () => 'new', staleWhileRevalidate: 30, refreshLeaseMs: 45_000 });
                await vi.waitFor(() => expect(mock.redis.set).toHaveBeenCalledWith('test-app:c:k:LEASE', expect.any(String), { NX: true, PX: 45_000 }));
            });

            it('skips the refresh when another instance holds the lease', async () => {
                mock.queueExec(['old', expired()]);
                mock.redis.set.mockResolvedValueOnce(null);
                const load = vi.fn(async () => 'new');

                expect(await lazy().getOrSet({ key: 'k', tags: ['t'], load, staleWhileRevalidate: 30 })).toBe('old');
                await new Promise((resolve) => setTimeout(resolve, 10));
                expect(load).not.toHaveBeenCalled();
            });

            it('loads normally once the value is older than the window', async () => {
                mock.queueExec(['old', expired()]);
                expect(await lazy().getOrSet({ key: 'k', tags: ['t'], load: () => 'new', staleWhileRevalidate: 2 })).toBe('new');
            });

            it('staleIfError returns the stale value when load fails within the window', async () => {
                mock.queueExec(['old', expired()], ['old', expired()]);
                const load = async () => { throw new Error('db down'); };

                expect(await lazy().getOrSet({ key: 'k', tags: ['t'], load, staleIfError: 30 })).toBe('old');
                await expect(lazy().getOrSet({ key: 'k', tags: ['t'], load, staleIfError: 2 })).rejects.toThrow('db down');
            });

            it('ignores stale entries without either option', async () => {
                mock.queueExec(['old', 0, expired()]);
                expect(await create({ staleTtl: 60 }).getOrSet({ key: 'k', tags: ['t'], load: () => 'new' })).toBe('new');
            });
        });

        it('rejects a load() that does not resolve to a string, without caching it', async () => {
            mock.queueExec([null, 0, null]);
            const load = (async () => ({ id: 1 })) as unknown as () => Promise<string>;

            await expect(tagCache.getOrSet({ key: 'k', tags: ['t'], load })).rejects.toThrow('getOrSet() load() must resolve to a string (got object)');
            expect(mock.redis.evalSha).not.toHaveBeenCalled();
        });

        it('still returns the loaded value when Redis is unavailable', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load: () => 'fresh' })).toBe('fresh');
            expect(mock.redis.evalSha).not.toHaveBeenCalled();
        });
    });

    describe('circuitBreaker', () => {
        it('stops calling Redis after consecutive failures, then probes once and closes', async () => {
            const events: unknown[] = [];
            const cache = create({ circuitBreaker: { failureThreshold: 2, cooldownMs: 40 }, onEvent: (e: { type: string }) => e.type === 'circuit' && events.push(e) });
            mock.redis.evalSha.mockRejectedValue(new Error('READONLY'));

            expect(await cache.set({ key: 'k', value: 'v', tags: ['t'] })).toBe(false);
            expect(await cache.set({ key: 'k', value: 'v', tags: ['t'] })).toBe(false);
            expect(events).toEqual([{ type: 'circuit', state: 'open' }]);

            expect(await cache.get({ key: 'k', tags: ['t'] })).toBeNull();
            expect(mock.redis.multi).not.toHaveBeenCalled(); // short-circuited

            await new Promise((resolve) => setTimeout(resolve, 50));
            mock.redis.evalSha.mockResolvedValue(1);
            const [probe, refused] = await Promise.all([
                cache.set({ key: 'k', value: 'v', tags: ['t'] }),
                cache.set({ key: 'k', value: 'v', tags: ['t'] }),
            ]);
            expect([probe, refused]).toEqual([true, false]); // one probe at a time
            expect(events).toEqual([{ type: 'circuit', state: 'open' }, { type: 'circuit', state: 'closed' }]);
            expect(await cache.set({ key: 'k', value: 'v', tags: ['t'] })).toBe(true);
        });

        it('reopens when the probe fails', async () => {
            const cache = create({ circuitBreaker: { failureThreshold: 1, cooldownMs: 20 } });
            mock.redis.evalSha.mockRejectedValue(new Error('down'));
            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            await new Promise((resolve) => setTimeout(resolve, 30));
            await cache.set({ key: 'k', value: 'v', tags: ['t'] }); // failed probe
            mock.redis.evalSha.mockClear();

            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            expect(mock.redis.evalSha).not.toHaveBeenCalled();
        });

        it('neither counts invalid input as a Redis failure nor lets it reset the failure count', async () => {
            const cache = create({ circuitBreaker: { failureThreshold: 2, cooldownMs: 1000 } });
            await cache.get({ key: '  ', tags: ['t'] });
            mock.queueExec(['v', 0, future()]);
            expect(await cache.get({ key: 'k', tags: ['t'] })).toBe('v');

            mock.redis.evalSha.mockRejectedValue(new Error('down'));
            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            await cache.get({ key: '  ', tags: ['t'] });
            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            mock.redis.evalSha.mockClear();
            await cache.set({ key: 'k', value: 'v', tags: ['t'] });
            expect(mock.redis.evalSha).not.toHaveBeenCalled(); // opened after 2 real failures
        });
    });

    describe('retryInvalidations', () => {
        const failingBatch = () =>
            mock.redis.multi.mockImplementationOnce(() => {
                const batch: any = { zRange: () => batch, unlink: () => batch, set: () => batch };
                batch.exec = async () => { throw new Error('connection lost'); };
                return batch;
            });

        it('queues failed invalidations, treats their tags as misses locally, and replays them', async () => {
            const events: any[] = [];
            const cache = create({ retryInvalidations: true, onEvent: (e: any) => e.type === 'invalidate' && events.push(e) });
            failingBatch();

            expect(await cache.invalidate({ tags: ['users'], deleteCacheKeys: false })).toBe(false);
            expect(cache.pendingInvalidations).toBe(1);
            expect(events[0]).toMatchObject({ ok: false, queued: true });

            mock.redis.multi.mockClear();
            expect(await cache.get({ key: 'k', tags: ['users', 'other'] })).toBeNull();
            expect(await cache.isMember({ key: 'k', tags: ['users'] })).toBe(false);
            expect(mock.redis.multi).not.toHaveBeenCalled(); // answered locally, without Redis

            mock.queueExec(['v', 0, future()]);
            expect(await cache.get({ key: 'k', tags: ['other'] })).toBe('v'); // other tags are unaffected

            expect(await cache.flushInvalidations()).toBe(true);
            expect(cache.pendingInvalidations).toBe(0);
            expect(events[1]).toMatchObject({ ok: true, attempt: 1 });
            mock.queueExec(['v', 0, future()]);
            expect(await cache.get({ key: 'k', tags: ['users'] })).toBe('v');
        });

        it('merges identical failed invalidations and keeps retrying while Redis is down', async () => {
            const cache = create({ retryInvalidations: { maxDelayMs: 1000 } });
            failingBatch();
            failingBatch();
            await cache.invalidate({ tags: ['a', 'b'] });
            await cache.invalidate({ tags: ['B', 'a'] });
            expect(cache.pendingInvalidations).toBe(1);

            failingBatch();
            expect(await cache.flushInvalidations()).toBe(false);
            expect(cache.pendingInvalidations).toBe(1);
            expect(await cache.flushInvalidations()).toBe(true);
        });

        it('never runs two retry passes at once', async () => {
            const cache = create({ retryInvalidations: true });
            failingBatch();
            await cache.invalidate({ tags: ['a'], deleteCacheKeys: false });
            const before = mock.batches.length;

            expect(await Promise.all([cache.flushInvalidations(), cache.flushInvalidations()])).toEqual([true, true]);
            expect(mock.batches.length - before).toBe(1); // replayed once, not once per flush
        });

        it('retries on its own with backoff', async () => {
            const cache = create({ retryInvalidations: true });
            failingBatch();
            await cache.invalidate({ tags: ['a'] });
            await vi.waitFor(() => expect(cache.pendingInvalidations).toBe(0), { timeout: 1000 });
        });

        it('does not queue invalid input or anything when disabled', async () => {
            const cache = create({ retryInvalidations: true });
            await cache.invalidate({ tags: [] });
            expect(cache.pendingInvalidations).toBe(0);

            failingBatch();
            await tagCache.invalidate({ tags: ['a'] });
            expect(tagCache.pendingInvalidations).toBe(0);
        });
    });

    describe('onEvent', () => {
        it('reports invalidations, errors, and getOrSet hits and misses', async () => {
            const events: unknown[] = [];
            const cache = create({ onEvent: (event: unknown) => events.push(event) });

            await cache.invalidate({ tags: ['a'], deleteCacheKeys: false });
            mock.queueExec(['v', 0, future()]);
            await cache.getOrSet({ key: 'k', tags: ['t'], load: () => 'x' });
            mock.redis.isReady = false;
            await cache.invalidate({ tags: ['a'] });

            expect(events).toEqual([
                { type: 'invalidate', tags: ['a'], hard: false, ok: true, durationMs: expect.any(Number) },
                { type: 'hit', key: 'k', source: 'redis' },
                { type: 'error', operation: 'invalidate', error: expect.any(Error) },
                { type: 'invalidate', tags: ['a'], hard: true, ok: false, durationMs: expect.any(Number) },
            ]);
        });

        it('logs instead of throwing when the handler throws', async () => {
            const cache = create({ onEvent: () => { throw new Error('metrics down'); } });
            expect(await cache.invalidate({ tags: ['a'], deleteCacheKeys: false })).toBe(true);
            expect(logger.error).toHaveBeenCalledWith('[TagCache] onEvent handler failed:', expect.any(Error));
        });
    });

    describe('getTagVersions', () => {
        it('creates missing tokens and returns the current ones', async () => {
            mock.queueExec(['OK', 'created', null, 'existing']);

            expect(await tagCache.getTagVersions({ tags: ['tag1', 'tag2'] })).toEqual({
                versions: { 'test-app:t:tag1:VERSION': 'created', 'test-app:t:tag2:VERSION': 'existing' },
            });
            expect(mock.batches[0].commands).toEqual([
                ['set', 'test-app:t:tag1:VERSION', expect.any(String), { NX: true, EX: 240 }],
                ['get', 'test-app:t:tag1:VERSION'],
                ['set', 'test-app:t:tag2:VERSION', expect.any(String), { NX: true, EX: 240 }],
                ['get', 'test-app:t:tag2:VERSION'],
            ]);
        });

        it('returns null and logs on error', async () => {
            mock.queueExec(['OK', null]);
            expect(await tagCache.getTagVersions({ tags: ['tag1'] })).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('[TagCache] getTagVersions() failed:', expect.any(Error));
        });
    });
});
