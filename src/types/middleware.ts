import type { Request, Response } from "express";
import type { TagCache } from "../tagcache.js";
import type { ResolvedCacheSettings } from "./tagcache.js";

/**
 * A tag: either a fixed string or a function that derives one from the request.
 *
 * @example ['products', (req) => `product:${req.params.id}`]
 */
export type TagInput = string | ((req: Request) => string);

/**
 * Options for the TagcacheMiddleware constructor.
 */
export interface TagcacheMiddlewareConstructorOpts {
    /** The cache to read from and write to. */
    tagcache: TagCache;
    /** `false` turns `cache()` into a pass-through (`X-Cache: BYPASS`) and `invalidate()` into a no-op. */
    enable: boolean;
    /** Default for the `coalesce` option of `cache()`. Default `false`. */
    coalesce?: boolean | CoalesceOptions;
    /** Default for the `authGuard` option of `cache()`. Default `'off'`. */
    authGuard?: AuthGuardMode;
    /** Default for the `honorRequestCacheControl` option of `cache()`. Default `true`. */
    honorRequestCacheControl?: boolean;
}

/**
 * Settings for request coalescing (`coalesce`).
 */
export interface CoalesceOptions {
    /**
     * Longest a request waits for an identical request already running the route, in
     * milliseconds; after that it runs the route itself. Default: no limit.
     */
    timeoutMs?: number;
}

/**
 * What `cache()` does with a request that has an `Authorization` header on a route without `vary`
 * or `key`, whose response therefore could be served to other users: `'skip'` bypasses the cache
 * for it, `'warn'` caches it but logs a warning once per route, `'off'` does nothing.
 */
export type AuthGuardMode = 'off' | 'warn' | 'skip';

/**
 * Options for `TagcacheMiddleware.cache()`.
 */
export interface TagcacheMiddlewareCacheOpts {
    /**
     * Extra input for the cache key, for responses that differ by something other than the
     * method, path, params, query and body — typically the authenticated user. Called once per
     * request; the result is JSON-serialized into the key.
     *
     * @example { vary: (req) => req.user?.id }
     */
    vary?: (req: Request) => unknown;
    /**
     * Query parameters left out of the cache key, so links that differ only in tracking
     * parameters share one entry. A trailing `*` matches a prefix.
     *
     * @example { ignoreQuery: ['utm_*', 'fbclid'] }
     */
    ignoreQuery?: string[];
    /**
     * When several identical requests miss at the same time, run the route once and serve its
     * response to the others (as `X-Cache: HIT`) instead of running it for each of them. Requests
     * wait only for a response that ends up cached; otherwise they run the route themselves.
     * Pass `{ timeoutMs }` to bound the wait. Defaults to the constructor's `coalesce` (`false`).
     */
    coalesce?: boolean | CoalesceOptions;
    /** Seconds entries from this route live. Defaults to the TagCache's `cacheTtl`. */
    ttl?: number;
    /**
     * Only requests with these methods use the cache; others pass through with `X-Cache: BYPASS`.
     * Default: every method the route handles.
     *
     * @example { methods: ['GET', 'HEAD'] }
     */
    methods?: string[];
    /**
     * Derives the cache key yourself instead of from the path, params, query and body. The result
     * is hashed together with the method, so it may be any string; `vary` and `ignoreQuery` are
     * not applied.
     *
     * @example { key: (req) => `product:${req.params.id}:${req.query.currency ?? 'usd'}` }
     */
    key?: (req: Request) => string;
    /** Return `true` to let a request bypass the cache (`X-Cache: BYPASS`). */
    skip?: (req: Request) => boolean;
    /** See {@link AuthGuardMode}. Defaults to the constructor's `authGuard` (`'off'`). */
    authGuard?: AuthGuardMode;
    /**
     * Whether requests can skip the cache with `Cache-Control: no-cache|no-store` or `Pragma: no-cache`.
     * Set it to `false` in production so clients cannot force every request through to your
     * database. Defaults to the constructor's `honorRequestCacheControl` (`true`).
     */
    honorRequestCacheControl?: boolean;
    /**
     * Seconds past expiry during which an entry is still served (`X-Cache: STALE`) while a single
     * request, across all instances, runs the route to refresh it; if that refresh fails with a
     * 5xx, the refreshing request is served the stale entry too. Entries whose tags were
     * invalidated are never served. Needs the TagCache's `staleTtl` to be at least this long.
     */
    staleWhileRevalidate?: number;
    /**
     * Seconds past expiry during which an entry is served (`X-Cache: STALE`) instead of a 5xx
     * response from the route, e.g. while the database is down. Applies to errors sent with
     * `res.status(5xx)` and to errors passed to Express's error handler, as long as no headers were
     * sent yet. Needs the TagCache's `staleTtl` to be at least this long.
     */
    staleIfError?: number;
    /**
     * Refresh popular entries shortly before they expire instead of letting them expire for
     * everyone at once (probabilistic early expiration, "XFetch"). On each hit, a request runs the
     * route early with a probability that grows as expiry nears and with how long the route takes;
     * the refresh holds a lease, so one request across all instances does it while the rest keep
     * getting hits. `beta` above 1 refreshes earlier (default 1).
     */
    earlyRefresh?: boolean | { beta?: number };
    /**
     * Detect stale cache entries in production: a `sampleRate` fraction of hits (e.g. `0.001`) runs
     * the route anyway and compares its response with the cached one. A difference means a tag is
     * missing from some `invalidate()`; it is logged, reported as a `stale-detected` event, and the
     * entry is replaced. Sampled requests are served the fresh response (or the cached one if the
     * route fails). `compare` decides equality, e.g. to ignore timestamps; default: identical bodies.
     */
    verify?: { sampleRate: number; compare?: (cached: string, fresh: string) => boolean };
}

/**
 * Options for `TagcacheMiddleware.invalidate()`.
 */
export interface TagcacheMiddlewareInvalidateOpts {
    /** `true` deletes cached values as well as tag indexes. Defaults to the TagCache's `deleteCacheKeys`. */
    deleteCacheKeys?: boolean;
    /** Namespace to invalidate in. Defaults to the TagCache's `appContext`. */
    appContext?: string;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface BypassCacheOptions {
    req: Request;
    enable: boolean;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface ResolveTagsOptions {
    req: Request;
    tags: TagInput[];
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface SortObjectOptions {
    value: any;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface GenerateCacheKeyOptions {
    req: Request;
    options: ResolvedCacheSettings;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface TryServeFromCacheOptions {
    tagcache: TagCache;
    tags: string[];
    req: Request;
    res: Response;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface ShouldCacheResponseOptions {
    res: Response;
    body: unknown;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface AttachCacheWriterOptions {
    req: Request;
    res: Response;
    tags: string[];
    tagcache: TagCache;
}

/** @deprecated Internal helper type, not part of the supported API. Will be removed in v3. */
export interface AttachInvalidationListenerOptions {
    res: Response;
    tags: string[];
    tagcache: TagCache;
    deleteCacheKeys: boolean;
    appContext: string;
}
