/**
 * Structural type for the Redis client accepted by {@link TagCacheOptions.redis}.
 *
 * Any node-redis v4 or v5 client (the result of `createClient()`, including clients with
 * modules, scripts or RESP3) satisfies it. node-redis client types are not assignable to
 * each other across those variations, so the option is typed by shape instead of by
 * `RedisClientType`.
 */
export interface RedisClientLike {
    readonly isOpen: boolean;
    readonly isReady: boolean;
    multi(): unknown;
    unlink(...args: any[]): Promise<unknown>;
    eval(...args: any[]): Promise<unknown>;
    evalSha(...args: any[]): Promise<unknown>;
}

/**
 * Receives errors that TagCache and TagcacheMiddleware catch instead of throwing.
 * `console` satisfies it, as do most loggers (pino, winston, bunyan).
 */
export interface TagCacheLogger {
    error(message: string, error?: unknown): void;
}

/**
 * Configuration of a TagCache instance after defaults are applied (`tagcache.cacheOptions`).
 */
export interface ResolvedCacheSettings {
    /** Prefix for cached value keys. Default `'tagcache:data:'`. */
    cachePrefix: string;
    /** Prefix for tag index keys. Default `'tagcache:tag:'`. */
    tagPrefix: string;
    /** Default TTL of cached values, in whole seconds. Default `180`. */
    cacheTtl: number;
    /** Minimum TTL of tag indexes, in whole seconds. Default `240`. */
    tagTtl: number;
    /** Namespace placed before every key. Default `'tagcache'`. */
    appContext: string;
    /** Largest response body the middleware caches, in kilobytes. Default `2048`. */
    sizeGuard: number;
    /** Whether invalidation deletes cached values too (hard) or only tag indexes (soft). Default `true`. */
    deleteCacheKeys: boolean;
    /** `'strict'` also prunes expired tag index entries on reads; `'lazy'` prunes on writes only. Default `'strict'`. */
    tagIndexMaintenanceMode: 'strict' | 'lazy';
}

/**
 * Options for `new TagCache()`. Everything except `redis` is optional; invalid values
 * fall back to the defaults listed on {@link ResolvedCacheSettings}.
 */
export interface TagCacheOptions extends Partial<ResolvedCacheSettings> {
    /** A connected node-redis v4 or v5 client. */
    redis: RedisClientLike;
    /** Where caught errors are reported. Default `console`. */
    logger?: TagCacheLogger;
}

/**
 * Parameters for `TagCache.get()`.
 */
export interface CacheFetchOptions {
    /** The un-prefixed cache key. Trimmed and lowercased. */
    key: string;
    /** Tags the entry must still belong to. Only these tags are checked. */
    tags: string[];
    /** Namespace to read from instead of the instance's `appContext`. */
    appContext?: string;
}

/**
 * Parameters for `TagCache.set()`.
 */
export interface CacheStoreOptions {
    /** The un-prefixed cache key. Trimmed and lowercased. */
    key: string;
    /** The value to store, usually serialized JSON. */
    value: string;
    /** Tags to attach the entry to. */
    tags: string[];
    /** TTL of this entry in whole seconds. Defaults to the instance's `cacheTtl`. */
    cacheTtl?: number;
    /** Minimum TTL of the tag indexes in whole seconds. Defaults to the instance's `tagTtl`. */
    tagTtl?: number;
    /** Namespace to write to instead of the instance's `appContext`. */
    appContext?: string;
}

/**
 * Parameters for `TagCache.invalidate()`.
 */
export interface CacheInvalidationOptions {
    /** Tags to invalidate. */
    tags: string[];
    /** `true` deletes cached values as well as tag indexes. Defaults to the instance's `deleteCacheKeys`. */
    deleteCacheKeys?: boolean;
    /** Namespace to invalidate in instead of the instance's `appContext`. */
    appContext?: string;
}

/**
 * Parameters for `TagCache.isMember()`.
 */
export interface IsMemberOptions {
    /** The un-prefixed cache key. */
    key: string;
    /** Tags the key must belong to. */
    tags: string[];
    /** Namespace to check instead of the instance's `appContext`. */
    appContext?: string;
}

/**
 * Parameters for `TagCache.delete()`.
 */
export interface CacheDeleteOptions {
    /** The un-prefixed cache key. */
    key: string;
    /** Namespace to delete from instead of the instance's `appContext`. */
    appContext?: string;
}
