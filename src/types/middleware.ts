import { TagCache } from "../tagcache.js";
import type { Request, Response } from "express";
import { ResolvedCacheSettings } from "./tagcache.js";

export type TagInput = string | ((req: Request) => string);

/**
 * Options for the bypassCache utility.
 */
export interface BypassCacheOptions {
    req: Request;
    enable: boolean;
}

/**
 * Options for the resolveTags utility.
 */
export interface ResolveTagsOptions {
    req: Request;
    tags: TagInput[];
}

/**
 * Options for the sortObject utility.
 */
export interface SortObjectOptions {
    value: any;
}

/**
 * Options for the generateCacheKey utility.
 */
export interface GenerateCacheKeyOptions {
    req: Request;
    options: ResolvedCacheSettings;
}

/**
 * Options for the tryServeFromCache utility.
 */
export interface TryServeFromCacheOptions {
    tagcache: TagCache;
    tags: string[];
    req: Request;
    res: Response;
}

/**
 * Options for the shouldCacheResponse utility.
 */
export interface ShouldCacheResponseOptions {
    res: Response;
    body: unknown;
}

/**
 * Options for the attachCacheWriter utility.
 */
export interface AttachCacheWriterOptions {
    req: Request;
    res: Response;
    tags: string[];
    tagcache: TagCache;
}

/**
 * Options for the attachInvalidationListener utility.
 */
export interface AttachInvalidationListenerOptions {
    res: Response;
    tags: string[];
    tagcache: TagCache;
    deleteCacheKeys: boolean;
    appContext: string;
}

/**
 * Options for the TagcacheMiddleware constructor.
 */
export interface TagcacheMiddlewareConstructorOpts {
    tagcache: TagCache;
    enable: boolean;
}

/**
 * Options for the TagcacheMiddleware.invalidate method.
 */
export interface TagcacheMiddlewareInvalidateOpts {
    deleteCacheKeys?: boolean;
    appContext?: string;
}
