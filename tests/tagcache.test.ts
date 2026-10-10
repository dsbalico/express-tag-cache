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
            expect(keys).toEqual(['test-app:c:key1', 'test-app:t:tag1', 'test-app:t:tag2']);
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
            expect(keys).toEqual(['test-app:c:key1', 'test-app:t:tag1', 'test-app:t:tag2', 'test-app:t:tag1:VERSION']);
            expect(args.slice(5)).toEqual(['2', '3']);
        });

        it('returns false when the script skips the write', async () => {
            mock.redis.evalSha.mockResolvedValueOnce(0);
            expect(await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], ifTagVersions: { versions: {} } })).toBe(false);
            expect(logger.error).not.toHaveBeenCalled();
        });

        it('writes to the given appContext', async () => {
            await tagCache.set({ key: 'key1', value: 'v', tags: ['tag1'], appContext: 'other' });
            const { keys } = mock.redis.evalSha.mock.calls[0][1];
            expect(keys).toEqual(['other:c:key1', 'other:t:tag1']);
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
                ['incr', 'test-app:t:tag1:VERSION'],
                ['expire', 'test-app:t:tag1:VERSION', 240],
                ['incr', 'test-app:t:tag2:VERSION'],
                ['expire', 'test-app:t:tag2:VERSION', 240],
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

        it('keeps version counters for max(tagTtl, cacheTtl)', async () => {
            await create({ cacheTtl: 900, tagTtl: 60 }).invalidate({ tags: ['tag1'], deleteCacheKeys: false });
            expect(mock.batches[0].commands).toContainEqual(['expire', 'test-app:t:tag1:VERSION', 900]);
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
            mock.queueExec([null, 0, null]);
            mock.redis.mGet.mockResolvedValueOnce(['7']);

            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load: () => 'fresh', cacheTtl: 60 })).toBe('fresh');

            const { keys, arguments: args } = mock.redis.evalSha.mock.calls[0][1];
            expect(keys).toEqual(['test-app:c:k', 'test-app:t:t', 'test-app:t:t:VERSION']);
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

        it('still returns the loaded value when Redis is unavailable', async () => {
            mock.redis.isReady = false;
            expect(await tagCache.getOrSet({ key: 'k', tags: ['t'], load: () => 'fresh' })).toBe('fresh');
            expect(mock.redis.evalSha).not.toHaveBeenCalled();
        });
    });

    describe('getTagVersions', () => {
        it('reads version counters, mapping missing ones to an empty string', async () => {
            mock.redis.mGet.mockResolvedValueOnce(['4', null]);

            expect(await tagCache.getTagVersions({ tags: ['tag1', 'tag2'] })).toEqual({
                versions: { 'test-app:t:tag1:VERSION': '4', 'test-app:t:tag2:VERSION': '' },
            });
            expect(mock.redis.mGet).toHaveBeenCalledWith(['test-app:t:tag1:VERSION', 'test-app:t:tag2:VERSION']);
        });

        it('returns null and logs on error', async () => {
            mock.redis.mGet.mockRejectedValueOnce(new Error('boom'));
            expect(await tagCache.getTagVersions({ tags: ['tag1'] })).toBeNull();
            expect(logger.error).toHaveBeenCalledWith('[TagCache] getTagVersions() failed:', expect.any(Error));
        });
    });
});
