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
    coalesce?: boolean;
    /** Default for the `authGuard` option of `cache()`. Default `'off'`. */
    authGuard?: AuthGuardMode;
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
     * Defaults to the constructor's `coalesce` (`false`).
     */
    coalesce?: boolean;
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
     * Seconds past expiry during which an entry is still served (`X-Cache: STALE`) while a single
     * request, across all instances, runs the route to refresh it. Entries whose tags were
     * invalidated are never served. Needs the TagCache's `staleTtl` to be at least this long.
     */
    staleWhileRevalidate?: number;
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
