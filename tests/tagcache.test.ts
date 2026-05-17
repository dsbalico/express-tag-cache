import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagCache } from '../src/tagcache.js';

describe('TagCache', () => {
    let mockRedis: any;
    let tagCache: TagCache;

    beforeEach(() => {
        mockRedis = {
            isReady: true,
            isOpen: true,
            multi: vi.fn().mockReturnValue({
                get: vi.fn().mockReturnThis(),
                sIsMember: vi.fn().mockReturnThis(),
                set: vi.fn().mockReturnThis(),
                sAdd: vi.fn().mockReturnThis(),
                expire: vi.fn().mockReturnThis(),
                sMembers: vi.fn().mockReturnThis(),
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            }),
            del: vi.fn().mockResolvedValue(1)
        };

        tagCache = new TagCache({
            redis: mockRedis,
            appContext: 'test-app',
            cachePrefix: 'c:',
            tagPrefix: 't:'
        });
    });

    describe('constructor', () => {
        it('should initialize with provided config', () => {
            expect(tagCache.cacheOptions.appContext).toBe('test-app');
        });

        it('should throw if redis is missing', () => {
            // @ts-ignore
            expect(() => new TagCache({})).toThrow('[TagCache] A Redis client instance is required.');
        });
    });

    describe('set', () => {
        it('should call redis multi with correct commands', async () => {
            const multi = mockRedis.multi();
            mockRedis.multi.mockReturnValue(multi);

            await tagCache.set({
                key: 'key1',
                value: 'val1',
                tags: ['tag1'],
                cacheTtl: 100,
                tagTtl: 200
            });

            expect(multi.set).toHaveBeenCalledWith('test-app:c:key1', 'val1', { EX: 100 });
            expect(multi.sAdd).toHaveBeenCalledWith('test-app:t:tag1', 'test-app:c:key1');
            expect(multi.expire).toHaveBeenCalledWith('test-app:t:tag1', 200);
            expect(multi.exec).toHaveBeenCalled();
        });
    });

    describe('get', () => {
        it('should return null if data is not found', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue([null]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({ key: 'key1', tags: ['tag1'] });
            expect(result).toBeNull();
        });

        it('should return value if data exists and tags are valid', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue(['cached-data', true]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({ key: 'key1', tags: ['tag1'] });
            expect(result).toBe('cached-data');
            expect(multi.get).toHaveBeenCalledWith('test-app:c:key1');
            expect(multi.sIsMember).toHaveBeenCalledWith('test-app:t:tag1', 'test-app:c:key1');
        });

        it('should return null if any tag is invalid', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue(['cached-data', true, false]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({ key: 'key1', tags: ['tag1', 'tag2'] });
            expect(result).toBeNull();
        });
    });

    describe('invalidate', () => {
        it('should delete tags and optionally cache keys', async () => {
            const readMulti = mockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1', 'key2']]);
            
            const deleteMulti = {
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            mockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: true });

            expect(deleteMulti.del).toHaveBeenCalledWith(['test-app:t:tag1']);
            expect(deleteMulti.del).toHaveBeenCalledWith(['key1', 'key2']);
        });
    });

    describe('delete', () => {
        it('should delete a single key', async () => {
            await tagCache.delete({ key: 'key1' });
            expect(mockRedis.del).toHaveBeenCalledWith('test-app:c:key1');
        });
    });
});
