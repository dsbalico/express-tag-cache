import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagcacheMiddleware } from '../src/tagcache-middleware.js';

describe('TagcacheMiddleware', () => {
    let mockTagCache: any;
    let middleware: TagcacheMiddleware;
    let req: any;
    let res: any;
    let next: any;

    beforeEach(() => {
        mockTagCache = {
            get: vi.fn(),
            set: vi.fn(),
            invalidate: vi.fn(),
            cacheOptions: {
                cachePrefix: 'c:',
                appContext: 'test'
            }
        };

        middleware = new TagcacheMiddleware({
            tagcache: mockTagCache,
            enable: true
        });

        req = {
            method: 'GET',
            path: '/test',
            params: {},
            query: {},
            headers: {}
        };

        res = {
            setHeader: vi.fn(),
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            once: vi.fn(),
            getHeader: vi.fn(),
            statusCode: 200
        };

        next = vi.fn();
    });

    describe('cache()', () => {
        it('should bypass cache if enable is false', async () => {
            const disabledMiddleware = new TagcacheMiddleware({
                tagcache: mockTagCache,
                enable: false
            });

            await disabledMiddleware.cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'BYPASS');
            expect(next).toHaveBeenCalled();
        });

        it('should serve from cache if available', async () => {
            mockTagCache.get.mockResolvedValue(JSON.stringify({ data: 'hello' }));

            await middleware.cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'HIT');
            expect(res.json).toHaveBeenCalledWith({ data: 'hello' });
            expect(next).not.toHaveBeenCalled();
        });

        it('should call next and attach writer if cache miss', async () => {
            mockTagCache.get.mockResolvedValue(null);

            await middleware.cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'MISS');
            expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
            expect(next).toHaveBeenCalled();
        });
    });

    describe('invalidate()', () => {
        it('should attach invalidation listener', async () => {
            await middleware.invalidate(['tag1'])(req, res, next);

            expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
            expect(next).toHaveBeenCalled();
        });

        it('should skip if disabled', async () => {
           const disabledMiddleware = new TagcacheMiddleware({
                tagcache: mockTagCache,
                enable: false
            });

            await disabledMiddleware.invalidate(['tag1'])(req, res, next);
            expect(res.once).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('should pass appContext to invalidation listener for cross-service invalidation', async () => {
            await middleware.invalidate(['tag1'], 'other-service')(req, res, next);

            expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
            expect(next).toHaveBeenCalled();
        });

        it('should call tagcache.invalidate with correct tags when finish fires (no appContext)', async () => {
            let finishHandler: Function;
            res.once = vi.fn((event: string, handler: Function) => {
                if (event === 'finish') finishHandler = handler;
            });
            res.statusCode = 200;
            mockTagCache.invalidate.mockResolvedValue(true);

            await middleware.invalidate(['tag1'])(req, res, next);
            await finishHandler!();

            expect(mockTagCache.invalidate).toHaveBeenCalledWith({
                tags: ['tag1'],
                deleteCacheKeys: false
            });
        });

        it('should call tagcache.invalidate when finish fires with appContext for cross-service', async () => {
            let finishHandler: Function;
            res.once = vi.fn((event: string, handler: Function) => {
                if (event === 'finish') finishHandler = handler;
            });
            res.statusCode = 200;
            mockTagCache.invalidate.mockResolvedValue(true);

            await middleware.invalidate(['tag1'], 'other-service')(req, res, next);
            await finishHandler!();

            expect(mockTagCache.invalidate).toHaveBeenCalledWith({
                tags: ['tag1'],
                deleteCacheKeys: false,
                appContext: 'other-service'
            });
        });

        it('should not call tagcache.invalidate if response status is outside 200-304', async () => {
            let finishHandler: Function;
            res.once = vi.fn((event: string, handler: Function) => {
                if (event === 'finish') finishHandler = handler;
            });
            res.statusCode = 500;

            await middleware.invalidate(['tag1'])(req, res, next);
            await finishHandler!();

            expect(mockTagCache.invalidate).not.toHaveBeenCalled();
        });

        it('should skip invalidation if resolved tags are empty', async () => {
            await middleware.invalidate([])(req, res, next);

            expect(res.once).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('should resolve dynamic tags with appContext', async () => {
            req.params = { id: '42' };
            const dynamicTag = (r: any) => `user:${r.params.id}`;

            await middleware.invalidate([dynamicTag], 'other-service')(req, res, next);

            expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
            expect(next).toHaveBeenCalled();
        });
    });
});
