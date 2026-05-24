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
        it('should delete cache keys when deleteCacheKeys is explicitly set to true', async () => {
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

        it('should not delete cache keys when deleteCacheKeys is explicitly set to false', async () => {
            const readMulti = mockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1', 'key2']]);
            
            const deleteMulti = {
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            mockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: false });

            expect(deleteMulti.del).toHaveBeenCalledWith(['test-app:t:tag1']);
            expect(deleteMulti.del).not.toHaveBeenCalledWith(['key1', 'key2']);
        });

        it('should delete cache keys if deleteCacheKeys is omitted but instance deleteCacheKeys is true', async () => {
            const readMulti = mockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1', 'key2']]);
            
            const deleteMulti = {
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            mockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await tagCache.invalidate({ tags: ['tag1'] });

            expect(deleteMulti.del).toHaveBeenCalledWith(['test-app:t:tag1']);
            expect(deleteMulti.del).toHaveBeenCalledWith(['key1', 'key2']);
        });

        it('should not delete cache keys if deleteCacheKeys is omitted but instance deleteCacheKeys is false', async () => {
            const customTagCache = new TagCache({
                redis: mockRedis,
                appContext: 'test-app',
                cachePrefix: 'c:',
                tagPrefix: 't:',
                deleteCacheKeys: false
            });

            const readMulti = mockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1', 'key2']]);
            
            const deleteMulti = {
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            mockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await customTagCache.invalidate({ tags: ['tag1'] });

            expect(deleteMulti.del).toHaveBeenCalledWith(['test-app:t:tag1']);
            expect(deleteMulti.del).not.toHaveBeenCalledWith(['key1', 'key2']);
        });
    });

    describe('delete', () => {
        it('should delete a single key', async () => {
            await tagCache.delete({ key: 'key1' });
            expect(mockRedis.del).toHaveBeenCalledWith('test-app:c:key1');
        });
    });

    describe('isMember', () => {
        it('should return true if key is a member of all tags', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue([true, true]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.isMember({ key: 'key1', tags: ['tag1', 'tag2'] });
            expect(result).toBe(true);
            expect(multi.sIsMember).toHaveBeenCalledWith('test-app:t:tag1', 'test-app:c:key1');
            expect(multi.sIsMember).toHaveBeenCalledWith('test-app:t:tag2', 'test-app:c:key1');
        });

        it('should return false if key is not a member of any tag', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue([true, false]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.isMember({ key: 'key1', tags: ['tag1', 'tag2'] });
            expect(result).toBe(false);
        });

        it('should return false if exec returns empty', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue([]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.isMember({ key: 'key1', tags: ['tag1'] });
            expect(result).toBe(false);
        });
    });

    describe('cross-appContext operations', () => {
        it('get() should use the provided appContext instead of the instance default', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue(['cached-data', true]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({ key: 'key1', tags: ['tag1'], appContext: 'other-service' });

            expect(result).toBe('cached-data');
            expect(multi.get).toHaveBeenCalledWith('other-service:c:key1');
            expect(multi.sIsMember).toHaveBeenCalledWith('other-service:t:tag1', 'other-service:c:key1');
        });

        it('get() should fall back to instance appContext when appContext is not provided', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue(['cached-data', true]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({ key: 'key1', tags: ['tag1'] });

            expect(result).toBe('cached-data');
            expect(multi.get).toHaveBeenCalledWith('test-app:c:key1');
            expect(multi.sIsMember).toHaveBeenCalledWith('test-app:t:tag1', 'test-app:c:key1');
        });

        it('get() should correctly validate tags in a foreign appContext', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue(['data-from-other', true, false]);
            mockRedis.multi.mockReturnValue(multi);

            const result = await tagCache.get({
                key: 'foreign-key',
                tags: ['tag1', 'tag2'],
                appContext: 'foreign-service'
            });

            expect(result).toBeNull();
            expect(multi.get).toHaveBeenCalledWith('foreign-service:c:foreign-key');
            expect(multi.sIsMember).toHaveBeenCalledWith('foreign-service:t:tag1', 'foreign-service:c:foreign-key');
            expect(multi.sIsMember).toHaveBeenCalledWith('foreign-service:t:tag2', 'foreign-service:c:foreign-key');
        });

        it('set() should always use the instance appContext (no cross-context writes)', async () => {
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
        });

        it('invalidate() should use the instance appContext for tag formatting', async () => {
            const readMulti = mockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1']]);

            const deleteMulti = {
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            mockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await tagCache.invalidate({ tags: ['tag1'], deleteCacheKeys: true });

            expect(deleteMulti.del).toHaveBeenCalledWith(['test-app:t:tag1']);
        });

        it('isMember() should use the instance appContext for key formatting', async () => {
            const multi = mockRedis.multi();
            multi.exec.mockResolvedValue([true]);
            mockRedis.multi.mockReturnValue(multi);

            await tagCache.isMember({ key: 'key1', tags: ['tag1'] });

            expect(multi.sIsMember).toHaveBeenCalledWith('test-app:t:tag1', 'test-app:c:key1');
        });

        it('delete() should use the instance appContext for key formatting', async () => {
            await tagCache.delete({ key: 'key1' });

            expect(mockRedis.del).toHaveBeenCalledWith('test-app:c:key1');
        });
    });

    describe('UNLINK support', () => {
        let unlinkMockRedis: any;
        let unlinkTagCache: TagCache;

        beforeEach(() => {
            unlinkMockRedis = {
                isReady: true,
                isOpen: true,
                unlink: vi.fn().mockResolvedValue(1),
                multi: vi.fn().mockReturnValue({
                    get: vi.fn().mockReturnThis(),
                    sIsMember: vi.fn().mockReturnThis(),
                    set: vi.fn().mockReturnThis(),
                    sAdd: vi.fn().mockReturnThis(),
                    expire: vi.fn().mockReturnThis(),
                    sMembers: vi.fn().mockReturnThis(),
                    unlink: vi.fn().mockReturnThis(),
                    del: vi.fn().mockReturnThis(),
                    exec: vi.fn().mockResolvedValue([])
                })
            };

            unlinkTagCache = new TagCache({
                redis: unlinkMockRedis,
                appContext: 'test-app',
                cachePrefix: 'c:',
                tagPrefix: 't:',
                deleteCacheKeys: true
            });
        });

        it('invalidate() should call unlink instead of del when available', async () => {
            const readMulti = unlinkMockRedis.multi();
            readMulti.exec.mockResolvedValue([['key1', 'key2']]);

            const deleteMulti = {
                unlink: vi.fn().mockReturnThis(),
                del: vi.fn().mockReturnThis(),
                exec: vi.fn().mockResolvedValue([])
            };

            unlinkMockRedis.multi
                .mockReturnValueOnce(readMulti)
                .mockReturnValueOnce(deleteMulti);

            await unlinkTagCache.invalidate({ tags: ['tag1'] });

            expect(deleteMulti.unlink).toHaveBeenCalledWith(['test-app:t:tag1']);
            expect(deleteMulti.unlink).toHaveBeenCalledWith(['key1', 'key2']);
            expect(deleteMulti.del).not.toHaveBeenCalled();
        });

        it('delete() should call unlink instead of del when available', async () => {
            await unlinkTagCache.delete({ key: 'key1' });
            expect(unlinkMockRedis.unlink).toHaveBeenCalledWith('test-app:c:key1');
            expect(unlinkMockRedis.del).toBeUndefined();
        });
    });

    describe('error handling', () => {
        it('get() should return null if redis is not ready', async () => {
            mockRedis.isReady = false;
            const result = await tagCache.get({ key: 'key1', tags: ['tag1'] });
            expect(result).toBeNull();
        });

        it('set() should return false if redis is not ready', async () => {
            mockRedis.isReady = false;
            const result = await tagCache.set({ key: 'key1', value: 'val', tags: ['tag1'] });
            expect(result).toBe(false);
        });

        it('invalidate() should return false if redis is not ready', async () => {
            mockRedis.isReady = false;
            const result = await tagCache.invalidate({ tags: ['tag1'] });
            expect(result).toBe(false);
        });

        it('isMember() should return false if redis is not ready', async () => {
            mockRedis.isReady = false;
            const result = await tagCache.isMember({ key: 'key1', tags: ['tag1'] });
            expect(result).toBe(false);
        });

        it('delete() should return false if redis is not ready', async () => {
            mockRedis.isReady = false;
            const result = await tagCache.delete({ key: 'key1' });
            expect(result).toBe(false);
        });
    });
});
