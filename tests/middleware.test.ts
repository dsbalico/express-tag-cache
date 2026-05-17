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
    });
});
