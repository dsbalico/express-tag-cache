import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { TagCache } from '../tagcache.js';
import type { TagInput } from '../types/middleware.js';
import { formatPrefixedKey } from './tagcache-utils.js';

interface CacheWriterOptions {
    res: Response;
    tagcache: TagCache;
    cacheKey: string;
    tags: string[];
}

interface InvalidationOptions {
    res: Response;
    tagcache: TagCache;
    tags: string[];
    deleteCacheKeys: boolean;
    appContext: string;
}

/** Returns a copy of `value` with object keys sorted recursively, so equal inputs serialize identically. */
function sortKeys(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (Buffer.isBuffer(value)) return value.toString('base64');

    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
}

/** Reports an error through the TagCache's logger, or `console` when it has none. */
export function logError(tagcache: TagCache, message: string, error: unknown): void {
    (tagcache.logger ?? console).error(message, error);
}

/**
 * Derives the cache key for a request: a SHA-256 of the method, the full path (router mount
 * path included, trailing slash removed), params, query, and the body for POST/PUT/PATCH.
 */
export function generateCacheKey(req: Request): string {
    const path = `${req.baseUrl ?? ''}${req.path}`.replace(/\/$/, '');
    const material: Record<string, unknown> = { params: req.params, query: req.query };

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') material.body = req.body;

    return createHash('sha256')
        .update(`${req.method.toUpperCase()}:${path}:${JSON.stringify(sortKeys(material))}`)
        .digest('hex');
}

/**
 * True when caching is disabled or the request asks to skip caches
 * (`Cache-Control: no-cache|no-store` or `Pragma: no-cache`).
 */
export function bypassCache({ req, enable }: { req: Request; enable: boolean }): boolean {
    if (!enable) return true;

    const cacheControl = req.headers['cache-control'];
    if (typeof cacheControl === 'string') {
        const cc = cacheControl.toLowerCase();
        if (cc.includes('no-cache') || cc.includes('no-store')) return true;
    }

    const pragma = req.headers['pragma'];
    return typeof pragma === 'string' && pragma.toLowerCase().includes('no-cache');
}

/**
 * Evaluates dynamic tags against the request, trims them, and drops empty and duplicate ones.
 */
export function resolveTags({ req, tags }: { req: Request; tags: TagInput[] }): string[] {
    const resolved = new Set<string>();
    for (const tag of tags) {
        const value = String((typeof tag === 'function' ? tag(req) : tag) ?? '').trim();
        if (value) resolved.add(value);
    }
    return [...resolved];
}

/**
 * True when a finished response may be stored: a 2xx JSON response that does not set cookies
 * and is not marked `Cache-Control: private` or `no-store`.
 */
export function isCacheableResponse(res: Response): boolean {
    if (res.statusCode < 200 || res.statusCode >= 300) return false;
    if (res.getHeader('set-cookie') !== undefined) return false;

    const contentType = String(res.getHeader('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return false;

    const cacheControl = String(res.getHeader('cache-control') ?? '').toLowerCase();
    return !cacheControl.includes('private') && !cacheControl.includes('no-store');
}

/** Sends a cached JSON body with `X-Cache: HIT`. */
export function serveCachedResponse(res: Response, tagcache: TagCache, cacheKey: string, value: string): void {
    const { cachePrefix, appContext } = tagcache.cacheOptions;
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Key', formatPrefixedKey(cacheKey, cachePrefix, appContext));
    res.status(200).type('json').send(value);
}

/**
 * Captures the body passed to `res.send()` and stores it once the response has finished, if
 * {@link isCacheableResponse} allows it. Express routes `res.json()` and `res.send(object)`
 * through `res.send(string)`, so the stored bytes are exactly the bytes sent.
 */
export function attachCacheWriter({ res, tagcache, cacheKey, tags }: CacheWriterOptions): void {
    let body: string | Buffer | undefined;
    const originalSend = res.send as (...args: unknown[]) => Response;

    res.send = function (this: Response, ...args: unknown[]) {
        const [chunk] = args;
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) body = chunk;
        return originalSend.apply(this, args);
    } as Response['send'];

    res.once('finish', async () => {
        try {
            if (body === undefined || !isCacheableResponse(res)) return;

            const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
            if (size > tagcache.cacheOptions.sizeGuard * 1024) return;

            await tagcache.set({
                key: cacheKey,
                value: typeof body === 'string' ? body : body.toString('utf8'),
                tags,
            });
        } catch (error) {
            logError(tagcache, '[TagCache] Cache write error:', error);
        }
    });
}

/**
 * Delays `res.end()` of a successful (200–304) response until `tags` are invalidated, so a client
 * that reads right after receiving the response never sees the pre-mutation cache entry.
 * Other responses end immediately and invalidate nothing.
 */
export function attachInvalidationListener({ res, tagcache, tags, deleteCacheKeys, appContext }: InvalidationOptions): void {
    const originalEnd = res.end as (...args: unknown[]) => Response;
    let invalidation: Promise<void> | undefined;

    res.end = function (this: Response, ...args: unknown[]) {
        if (!invalidation) {
            if (res.statusCode < 200 || res.statusCode > 304) {
                res.end = originalEnd as Response['end'];
                return originalEnd.apply(this, args);
            }
            invalidation = tagcache.invalidate({ tags, deleteCacheKeys, appContext }).then(
                () => undefined,
                (error: unknown) => logError(tagcache, '[TagCache] Cache invalidation error:', error),
            );
        }
        invalidation
            .then(() => originalEnd.apply(this, args))
            .catch((error: unknown) => logError(tagcache, '[TagCache] Failed to end response after invalidation:', error));
        return this;
    } as Response['end'];
}
