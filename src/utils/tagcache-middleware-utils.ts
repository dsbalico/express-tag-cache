import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { TagCache } from '../tagcache.js';
import type { TagInput } from '../types/middleware.js';
import type { TagCacheEvent, TagVersions } from '../types/tagcache.js';
import { emitEvent, formatPrefixedKey } from './tagcache-utils.js';

interface CacheWriterOptions {
    res: Response;
    tagcache: TagCache;
    cacheKey: string;
    tags: string[];
    versions: TagVersions;
    /** The route, for events. */
    route: string;
    /** TTL for the stored entry, in seconds; the TagCache default when omitted. */
    ttl?: number;
    /** Called once with the stored body, or `null` if the response was not cached. */
    onSettled?: (value: string | null) => void;
    /** A cached body to send instead of a 5xx response from the route (stale-if-error). */
    fallback?: string;
}

/** Inputs to the cache key besides the request itself. */
export interface CacheKeyOptions {
    vary?: (req: Request) => unknown;
    /** Returns true for query parameter names to leave out of the key. */
    ignoreQuery?: (name: string) => boolean;
    /** Replaces the default key material; hashed together with the method. */
    key?: (req: Request) => string;
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

/** Passes a middleware event to the TagCache's `onEvent` hook, if it has one. */
export function emit(tagcache: TagCache, event: TagCacheEvent): void {
    emitEvent(tagcache, event);
}

/** The route a request matched, as reported in events: mount path plus route pattern. */
export function routeOf(req: Request): string {
    return `${req.baseUrl ?? ''}${req.route?.path ?? req.path}`;
}

/**
 * Derives the cache key for a request: a SHA-256 of the method, the full path (router mount
 * path included, trailing slash removed), params, query (minus ignored parameters), the body for
 * POST/PUT/PATCH, and the optional `vary` value. With a custom `key`, a SHA-256 of the method and
 * its result instead.
 */
export function generateCacheKey(req: Request, { vary, ignoreQuery, key }: CacheKeyOptions = {}): string {
    if (key) return createHash('sha256').update(`${req.method.toUpperCase()}:key:${key(req)}`).digest('hex');

    const path = `${req.baseUrl ?? ''}${req.path}`.replace(/\/$/, '');
    const query = ignoreQuery
        ? Object.fromEntries(Object.entries(req.query ?? {}).filter(([name]) => !ignoreQuery(name)))
        : req.query;
    const material: Record<string, unknown> = { params: req.params, query };

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') material.body = req.body;
    if (vary) material.vary = vary(req);

    return createHash('sha256')
        .update(`${req.method.toUpperCase()}:${path}:${JSON.stringify(sortKeys(material))}`)
        .digest('hex');
}

/**
 * Compiles `ignoreQuery` patterns (exact names, or prefixes ending in `*`) into a matcher.
 */
export function createQueryFilter(patterns: string[] | undefined): ((name: string) => boolean) | undefined {
    if (!patterns?.length) return undefined;
    const exact = new Set(patterns.filter((pattern) => !pattern.endsWith('*')));
    const prefixes = patterns.filter((pattern) => pattern.endsWith('*')).map((pattern) => pattern.slice(0, -1));
    return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Why a request skips the cache: `'disabled'` when caching is off, `'request'` when the request
 * asks to skip caches (`Cache-Control: no-cache|no-store` or `Pragma: no-cache`); otherwise `null`.
 */
export function bypassReason(req: Request, enable: boolean): 'disabled' | 'request' | null {
    if (!enable) return 'disabled';

    const cacheControl = req.headers['cache-control'];
    if (typeof cacheControl === 'string') {
        const cc = cacheControl.toLowerCase();
        if (cc.includes('no-cache') || cc.includes('no-store')) return 'request';
    }

    const pragma = req.headers['pragma'];
    return typeof pragma === 'string' && pragma.toLowerCase().includes('no-cache') ? 'request' : null;
}

/** True when {@link bypassReason} gives a reason to skip the cache. */
export function bypassCache({ req, enable }: { req: Request; enable: boolean }): boolean {
    return bypassReason(req, enable) !== null;
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

/** Sends a cached JSON body with `X-Cache: HIT` (or `STALE` for an expired entry). */
export function serveCachedResponse(res: Response, tagcache: TagCache, cacheKey: string, value: string, status: 'HIT' | 'STALE' = 'HIT'): void {
    const { cachePrefix, appContext } = tagcache.cacheOptions;
    res.setHeader('X-Cache', status);
    res.setHeader('X-Cache-Key', formatPrefixedKey(cacheKey, cachePrefix, appContext));
    res.status(200).type('json').send(value);
}

/**
 * Captures the body passed to `res.send()` and stores it once the response has finished, if
 * {@link isCacheableResponse} allows it. Express routes `res.json()` and `res.send(object)`
 * through `res.send(string)`, so the stored bytes are exactly the bytes sent.
 */
export function attachCacheWriter({ res, tagcache, cacheKey, tags, versions, route, ttl, onSettled, fallback }: CacheWriterOptions): void {
    let body: string | Buffer | undefined;
    let settled = false;
    let servedFallback = false;
    const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        onSettled?.(value);
    };
    const originalSend = res.send as (...args: unknown[]) => Response;
    const originalEnd = res.end as (...args: unknown[]) => Response;

    // Turns a 5xx that has not started sending into the fallback body. Returns whether it did.
    const useFallback = (): boolean => {
        if (fallback === undefined || servedFallback || res.headersSent || res.statusCode < 500) return false;
        servedFallback = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(fallback));
        res.setHeader('X-Cache', 'STALE');
        emit(tagcache, { type: 'hit', key: cacheKey, source: 'stale', route });
        return true;
    };

    res.send = function (this: Response, ...args: unknown[]) {
        if (useFallback()) return originalSend.call(this, fallback);
        const [chunk] = args;
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) body = chunk;
        return originalSend.apply(this, args);
    } as Response['send'];

    if (fallback !== undefined) {
        // Express's error handler writes with res.end() directly.
        res.end = function (this: Response, ...args: unknown[]) {
            if (useFallback()) return originalEnd.call(this, fallback);
            return originalEnd.apply(this, args);
        } as Response['end'];
    }

    res.once('finish', async () => {
        if (servedFallback) return settle(null);
        let stored: string | null = null;
        const report = (reason?: 'not-cacheable' | 'too-large' | 'rejected' | 'error', bytes?: number) =>
            emit(tagcache, { type: 'store', key: cacheKey, stored: reason === undefined, reason, bytes, route });
        try {
            if (body === undefined || !isCacheableResponse(res)) return report('not-cacheable');

            const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
            if (size > tagcache.cacheOptions.sizeGuard * 1024) return report('too-large', size);

            const value = typeof body === 'string' ? body : body.toString('utf8');
            if (await tagcache.set({ key: cacheKey, value, tags, cacheTtl: ttl, ifTagVersions: versions })) {
                stored = value;
                report(undefined, size);
            } else {
                report('rejected', size);
            }
        } catch (error) {
            logError(tagcache, '[TagCache] Cache write error:', error);
            report('error');
        } finally {
            settle(stored);
        }
    });
    // A response aborted before it finished is never cached.
    res.once('close', () => {
        if (!res.writableFinished) settle(null);
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
