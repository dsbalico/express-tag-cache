import { RedisClientType } from "redis";

/**
 * Internal configuration for the TagCache instance after resolving defaults.
 */
export interface ResolvedCacheSettings {
    cachePrefix: string;
    tagPrefix: string;
    cacheTtl: number;
    tagTtl: number;
    appContext: string;
    sizeGuard: number;
    deleteCacheKeys: boolean;
    tagIndexMaintenanceMode: 'strict' | 'lazy';
}

/**
 * Options for initializing a new TagCache instance.
 */
export interface TagCacheOptions extends Partial<ResolvedCacheSettings> {
    redis: RedisClientType;
}

/**
 * Parameters for retrieving a value from the cache.
 */
export interface CacheFetchOptions {
    key: string;
    tags: string[];
    appContext?: string;
}

/**
 * Parameters for storing a value in the cache.
 */
export interface CacheStoreOptions {
    key: string;
    value: string;
    tags: string[];
    cacheTtl?: number;
    tagTtl?: number;
    appContext?: string;
}

/**
 * Parameters for invalidating cached data by tags.
 */
export interface CacheInvalidationOptions {
    tags: string[];
    deleteCacheKeys?: boolean;
    appContext?: string;
}

/**
 * Parameters for checking if a key is a member of specific tags.
 */
export interface IsMemberOptions {
    key: string;
    tags: string[];
    appContext?: string
}
/**
 * Parameters for deleting a specific cache key.
 */
export interface CacheDeleteOptions {
    key: string;
    appContext?: string;
}
