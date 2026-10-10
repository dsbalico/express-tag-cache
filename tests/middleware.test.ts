import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagcacheMiddleware } from '../src/tagcache-middleware.js';

describe('TagcacheMiddleware', () => {
    let mockTagCache: any;
    let middleware: TagcacheMiddleware;
    let req: any;
    let res: any;
    let next: any;
    let finishHandler: () => Promise<void>;
    let originalEnd: ReturnType<typeof vi.fn>;
    const versions = { versions: { 'test:t:tag1:VERSION': '' } };

    beforeEach(() => {
        mockTagCache = {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(true),
            invalidate: vi.fn().mockResolvedValue(true),
            getTagVersions: vi.fn().mockResolvedValue(versions),
            logger: { error: vi.fn() },
            cacheOptions: { cachePrefix: 'c:', appContext: 'test', deleteCacheKeys: false, sizeGuard: 1 },
        };
        middleware = new TagcacheMiddleware({ tagcache: mockTagCache, enable: true });

        req = { method: 'GET', baseUrl: '', path: '/test', params: {}, query: {}, headers: {} };

        const headers: Record<string, unknown> = { 'content-type': 'application/json' };
        originalEnd = vi.fn();
        res = {
            statusCode: 200,
            headersSent: false,
            setHeader: vi.fn(),
            getHeader: vi.fn((name: string) => headers[name.toLowerCase()]),
            status: vi.fn().mockReturnThis(),
            type: vi.fn().mockReturnThis(),
            send: vi.fn().mockReturnThis(),
            end: originalEnd,
            once: vi.fn((event: string, handler: () => Promise<void>) => {
                if (event === 'finish') finishHandler = handler;
            }),
            headers,
        };
        next = vi.fn();
    });

    describe('cache()', () => {
        it('should bypass cache if enable is false', async () => {
            await new TagcacheMiddleware({ tagcache: mockTagCache, enable: false }).cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'BYPASS');
            expect(mockTagCache.get).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('should serve from cache if available', async () => {
            const cachedValue = JSON.stringify({ data: 'hello' });
            mockTagCache.get.mockResolvedValue(cachedValue);

            await middleware.cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'HIT');
            expect(res.setHeader).toHaveBeenCalledWith('X-Cache-Key', expect.stringMatching(/^test:c:[0-9a-f]{64}$/));
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.type).toHaveBeenCalledWith('json');
            expect(res.send).toHaveBeenCalledWith(cachedValue);
            expect(mockTagCache.getTagVersions).not.toHaveBeenCalled();
            expect(next).not.toHaveBeenCalled();
        });

        it('should snapshot tag versions and attach a writer on a miss', async () => {
            await middleware.cache(['tag1'])(req, res, next);

            expect(res.setHeader).toHaveBeenCalledWith('X-Cache', 'MISS');
            expect(mockTagCache.getTagVersions).toHaveBeenCalledWith({ tags: ['tag1'] });
            expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should cache the exact body sent, guarded by the version snapshot', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            const body = '{"data":"hello"}';
            res.send(body);
            await finishHandler();

            expect(mockTagCache.set).toHaveBeenCalledWith({
                key: mockTagCache.get.mock.calls[0][0].key,
                value: body,
                tags: ['tag1'],
                ifTagVersions: versions,
            });
        });

        it('should store Buffer bodies as their UTF-8 text', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            res.send(Buffer.from('{"a":1}'));
            await finishHandler();

            expect(mockTagCache.set).toHaveBeenCalledWith(expect.objectContaining({ value: '{"a":1}' }));
        });

        it('should write under the key computed before the handler ran', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            req.query = { mutated: 'by-handler' };
            res.send('{}');
            await finishHandler();

            expect(mockTagCache.set.mock.calls[0][0].key).toBe(mockTagCache.get.mock.calls[0][0].key);
        });

        it('should not cache when nothing was sent through res.send', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            res.send({ not: 'captured as an object' });
            await finishHandler();

            expect(mockTagCache.set).not.toHaveBeenCalled();
        });

        it('should not cache bodies larger than sizeGuard bytes', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            res.send(JSON.stringify({ text: '€'.repeat(400) })); // ~400 chars but ~1.2 KB
            await finishHandler();

            expect(mockTagCache.set).not.toHaveBeenCalled();
        });

        it('should not cache responses that set cookies', async () => {
            await middleware.cache(['tag1'])(req, res, next);
            res.headers['set-cookie'] = ['sid=1'];
            res.send('{}');
            await finishHandler();

            expect(mockTagCache.set).not.toHaveBeenCalled();
        });

        it('should not attach a writer when the version snapshot fails', async () => {
            mockTagCache.getTagVersions.mockResolvedValue(null);

            await middleware.cache(['tag1'])(req, res, next);

            expect(res.once).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should key responses by the vary option', async () => {
            await middleware.cache(['tag1'], { vary: () => 'alice' })(req, res, next);
            await middleware.cache(['tag1'], { vary: () => 'bob' })(req, res, next);

            expect(mockTagCache.get.mock.calls[0][0].key).not.toBe(mockTagCache.get.mock.calls[1][0].key);
        });

        it('should skip caching when tags resolve to nothing', async () => {
            await middleware.cache([() => ''])(req, res, next);

            expect(mockTagCache.get).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('should log and continue when a tag resolver throws', async () => {
            await middleware.cache([() => { throw new Error('bad tag'); }])(req, res, next);

            expect(mockTagCache.logger.error).toHaveBeenCalledWith('[TagCache] cache() middleware error:', expect.any(Error));
            expect(next).toHaveBeenCalledTimes(1);
        });
    });

    describe('invalidate()', () => {
        it('should skip if disabled', async () => {
            await new TagcacheMiddleware({ tagcache: mockTagCache, enable: false }).invalidate(['tag1'])(req, res, next);

            expect(res.end).toBe(originalEnd);
            expect(next).toHaveBeenCalled();
        });

        it('should skip if resolved tags are empty', async () => {
            await middleware.invalidate([])(req, res, next);

            expect(res.end).toBe(originalEnd);
            expect(next).toHaveBeenCalled();
        });

        it('should invalidate before ending a successful response', async () => {
            let resolveInvalidation!: (value: boolean) => void;
            mockTagCache.invalidate.mockReturnValue(new Promise((resolve) => { resolveInvalidation = resolve; }));

            await middleware.invalidate(['tag1'])(req, res, next);
            expect(next).toHaveBeenCalled();

            res.end('{"ok":true}');
            expect(mockTagCache.invalidate).toHaveBeenCalledWith({ tags: ['tag1'], deleteCacheKeys: false, appContext: 'test' });
            expect(originalEnd).not.toHaveBeenCalled();

            resolveInvalidation(true);
            await vi.waitFor(() => expect(originalEnd).toHaveBeenCalledWith('{"ok":true}'));
        });

        it('should end the response even if invalidation fails', async () => {
            mockTagCache.invalidate.mockRejectedValue(new Error('redis down'));

            await middleware.invalidate(['tag1'])(req, res, next);
            res.end();

            await vi.waitFor(() => expect(originalEnd).toHaveBeenCalled());
            expect(mockTagCache.logger.error).toHaveBeenCalledWith('[TagCache] Cache invalidation error:', expect.any(Error));
        });

        it('should not invalidate or delay responses outside 200-304', async () => {
            res.statusCode = 500;

            await middleware.invalidate(['tag1'])(req, res, next);
            res.end('error');

            expect(originalEnd).toHaveBeenCalledWith('error');
            expect(mockTagCache.invalidate).not.toHaveBeenCalled();
        });

        it('should pass appContext and deleteCacheKeys overrides', async () => {
            req.params = { id: '42' };

            await middleware.invalidate([(r: any) => `user:${r.params.id}`], { appContext: 'other-service', deleteCacheKeys: true })(req, res, next);
            res.end();

            expect(mockTagCache.invalidate).toHaveBeenCalledWith({ tags: ['user:42'], deleteCacheKeys: true, appContext: 'other-service' });
        });

        it('should invalidate only once when end is called repeatedly', async () => {
            await middleware.invalidate(['tag1'])(req, res, next);
            res.end('a');
            res.end();

            await vi.waitFor(() => expect(originalEnd).toHaveBeenCalledTimes(2));
            expect(mockTagCache.invalidate).toHaveBeenCalledTimes(1);
            expect(originalEnd.mock.calls).toEqual([['a'], []]);
        });
    });
});
