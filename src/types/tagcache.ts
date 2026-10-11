/**
 * Structural type for the Redis client accepted by {@link TagCacheOptions.redis}.
 *
 * Any node-redis v4, v5 or v6 client (the result of `createClient()`, including clients with
 * modules, scripts or RESP3) satisfies it. node-redis client types are not assignable to
 * each other across those variations, so the option is typed by shape instead of by
 * `RedisClientType`.
 */
export interface RedisClientLike {
    readonly isOpen: boolean;
    readonly isReady: boolean;
    multi(): unknown;
    set(...args: any[]): Promise<unknown>;
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
    /** Used for warnings when present; otherwise warnings go to `error`. */
    warn?(message: string): void;
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
    /** A connected node-redis v4, v5 or v6 client. */
    redis: RedisClientLike;
    /** Where caught errors are reported. Default `console`. */
    logger?: TagCacheLogger;
    /**
     * Milliseconds after which a Redis operation is abandoned and treated as failed (`get()`
     * returns `null`, others `false`). The command itself may still complete in Redis.
     * Default: no timeout.
     */
    operationTimeout?: number;
    /**
     * Milliseconds after an invalidation during which no instance may write entries for the
     * invalidated tags. Set it to your database replicas' worst-case lag, so a request that reads a
     * replica which has not caught up cannot put the old data back. Default: no fence.
     */
    replicaLagMs?: number;
    /**
     * Treat tags as paths: an entry tagged `tenant:42:users` also belongs to `tenant:42` and
     * `tenant`, so invalidating an ancestor invalidates everything below it. `true` splits on `:`;
     * pass `{ separator }` to split on something else. Every service that reads or writes the
     * namespace must use the same setting. Default: off.
     */
    hierarchicalTags?: boolean | { separator: string };
    /**
     * Randomly spreads each entry's TTL by up to this fraction in either direction (`0.1` turns 180 s
     * into 162–198 s), so entries written together do not all expire, and get recomputed, at once.
     * Must be between 0 and 1. Default: no jitter.
     */
    ttlJitter?: number;
    /**
     * Called synchronously for every cache event (hits, misses, stores, invalidations, errors), for
     * metrics and tracing. Keep it cheap; errors it throws are logged and otherwise ignored.
     */
    onEvent?: (event: TagCacheEvent) => void;
    /**
     * Stop calling Redis after `failureThreshold` consecutive failures (default 5) and answer every
     * operation with its fallback (`null`/`false`) for `cooldownMs` (default 5000). After the
     * cooldown one call probes Redis; success closes the circuit. `true` uses the defaults.
     * Default: off.
     */
    circuitBreaker?: boolean | { failureThreshold?: number; cooldownMs?: number };
    /**
     * Keep invalidations that failed (Redis down, timeout, open circuit) in memory and retry them
     * with exponential backoff, up to `maxDelayMs` between attempts (default 30000). Until a retry
     * succeeds, this instance treats the affected tags as misses, so it never serves data whose
     * invalidation was lost. Queued invalidations do not survive a restart; call
     * `flushInvalidations()` on shutdown. Default: off.
     */
    retryInvalidations?: boolean | { maxDelayMs?: number };
    /**
     * Make hard invalidation return as soon as the tags are invalidated (one round trip, like soft
     * invalidation) and delete the cached values afterwards, in batches. The values are already
     * unreachable at that point, so this only defers freeing memory. Default: off.
     */
    backgroundPurge?: boolean;
    /**
     * Seconds an entry stays readable after it expires, for `lookup()`, stale-while-revalidate and
     * stale-if-error. `get()` never returns expired entries, and invalidated entries are never
     * returned at all. Default `0`.
     */
    staleTtl?: number;
}

/**
 * An event passed to `onEvent`. `key` is the un-prefixed cache key; `route` is the Express route
 * (mount path plus route pattern) for events raised by the middleware.
 */
export type TagCacheEvent =
    | { type: 'hit'; key: string; source: 'redis' | 'coalesced' | 'stale'; route?: string }
    | { type: 'miss'; key: string; route?: string }
    | { type: 'refresh'; key: string; reason: 'stale' | 'early' | 'verify'; route?: string }
    | { type: 'stale-detected'; key: string; route?: string }
    | { type: 'bypass'; reason: 'disabled' | 'request' | 'method' | 'skipped' | 'authorization'; route?: string }
    | {
          type: 'store';
          key: string;
          stored: boolean;
          /** Why the response was not stored, when `stored` is false. */
          reason?: 'not-cacheable' | 'too-large' | 'rejected' | 'error';
          bytes?: number;
          route?: string;
      }
    | {
          type: 'invalidate';
          tags: string[];
          hard: boolean;
          ok: boolean;
          durationMs: number;
          /** Set when the invalidation failed and was queued for retry (`retryInvalidations`). */
          queued?: boolean;
          /** Set on retries: 1 for the first retry, and so on. */
          attempt?: number;
      }
    | { type: 'error'; operation: string; error: unknown }
    | { type: 'circuit'; state: 'open' | 'closed' };

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
    /**
     * A snapshot from `getTagVersions()` taken before the value was loaded. If any of these
     * tags has been invalidated since, the write is skipped and `set()` resolves to `false`.
     */
    ifTagVersions?: TagVersions;
}

/**
 * An entry returned by `TagCache.lookup()`.
 */
export interface CacheLookupResult {
    value: string;
    /** When the entry expires or expired, in milliseconds since the epoch. */
    expiresAt: number;
    /** Whether the entry has expired but is still within `staleTtl`. */
    stale: boolean;
}

/**
 * Parameters for `TagCache.inspectTag()`.
 */
export interface CacheInspectTagOptions {
    tag: string;
    /** Maximum number of keys to return. Default `20`. */
    limit?: number;
    appContext?: string;
}

/**
 * What `TagCache.inspectTag()` found: the unexpired entries an invalidation of the tag would affect.
 */
export interface CacheTagInspection {
    /** Number of unexpired entries indexed under the tag. */
    entries: number;
    /** Redis keys of up to `limit` of those entries. */
    keys: string[];
    /** Seconds until the tag index expires; `-2` when it does not exist. */
    ttl: number;
}

/**
 * Parameters for `TagCache.acquireLease()`.
 */
export interface CacheLeaseOptions {
    /** The un-prefixed cache key the lease is for. */
    key: string;
    /** How long the lease lasts if it is not released, in milliseconds. Default `10000`. */
    ttlMs?: number;
    appContext?: string;
}

/**
 * Parameters for `TagCache.releaseLease()`.
 */
export interface CacheLeaseReleaseOptions {
    key: string;
    /** The token returned by `acquireLease()`. */
    token: string;
    appContext?: string;
}

/**
 * Parameters for `TagCache.getOrSet()`.
 */
export interface CacheGetOrSetOptions {
    /** The un-prefixed cache key. Trimmed and lowercased. */
    key: string;
    /** Tags to check on read and to attach on write. */
    tags: string[];
    /** Produces the value on a miss. Concurrent misses for the same key share one call. */
    load: () => string | Promise<string>;
    /** TTL of the entry in whole seconds. Defaults to the instance's `cacheTtl`. */
    cacheTtl?: number;
    /** Minimum TTL of the tag indexes in whole seconds. Defaults to the instance's `tagTtl`. */
    tagTtl?: number;
    /** Namespace to use instead of the instance's `appContext`. */
    appContext?: string;
    /**
     * Seconds past expiry during which the expired value is returned immediately while one caller,
     * across all instances, refreshes it in the background. Needs `staleTtl` at least this long.
     */
    staleWhileRevalidate?: number;
    /**
     * Seconds past expiry during which the expired value is returned if `load()` fails, instead of
     * the error. Needs `staleTtl` at least this long.
     */
    staleIfError?: number;
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

/**
 * Parameters for `TagCache.getTagVersions()`.
 */
export interface TagVersionsOptions {
    /** Tags to snapshot. Use the same tags you will pass to `set()`. */
    tags: string[];
    /** Namespace of the tags. Defaults to the instance's `appContext`. */
    appContext?: string;
}

/**
 * Opaque snapshot of tag version tokens, returned by `getTagVersions()` and accepted by
 * `set({ ifTagVersions })`.
 */
export interface TagVersions {
    readonly versions: Readonly<Record<string, string>>;
}
