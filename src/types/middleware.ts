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
}

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
