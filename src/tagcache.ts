import { createHash, randomBytes } from 'node:crypto';
import type { RedisClientType } from 'redis';
import defaultConfig from './config/default.js';
import {
    ensureRedisClientIsReady,
    formatPrefixedKey,
    formatTagKeys,
    formatTagVersionKey,
    getValidTtlWithFallback,
} from './utils/tagcache-utils.js';
import type {
    CacheDeleteOptions,
    CacheFetchOptions,
    CacheGetOrSetOptions,
    CacheInvalidationOptions,
    CacheStoreOptions,
    IsMemberOptions,
    ResolvedCacheSettings,
    TagCacheLogger,
    TagCacheOptions,
    TagVersions,
    TagVersionsOptions,
} from './types/tagcache.js';

type RedisMulti = ReturnType<RedisClientType['multi']>;

/**
 * Atomically writes a value and its tag index entries.
 *
 * KEYS: [1] value key, [2..n+1] tag index keys, [n+2..] tag version keys to verify.
 * ARGV: [1] value, [2] value TTL (s), [3] tag index TTL (ms), [4] now (ms), [5] entry expiry (ms),
 *       [6] n, [7..] expected tag versions.
 *
 * Returns 0 without writing when a tag version differs from the expected one, i.e. the tag was
 * invalidated after the caller snapshotted it. Otherwise prunes expired index entries, adds the
 * entry, only ever extends the index TTL (so a short-lived write cannot cut a long-lived entry's
 * index short), and returns 1.
 */
const SET_SCRIPT = `
local n = tonumber(ARGV[6])
for i = n + 2, #KEYS do
  if (redis.call('GET', KEYS[i]) or '') ~= ARGV[i + 5 - n] then return 0 end
end
local tagTtl = tonumber(ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
for i = 2, n + 1 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[4])
  redis.call('ZADD', KEYS[i], ARGV[5], KEYS[1])
  if redis.call('PTTL', KEYS[i]) < tagTtl then redis.call('PEXPIRE', KEYS[i], tagTtl) end
end
return 1
`;
const SET_SCRIPT_SHA = createHash('sha1').update(SET_SCRIPT).digest('hex');

/** Maximum number of keys per UNLINK command during hard invalidation. */
const UNLINK_BATCH_SIZE = 1000;

/**
 * Tag-based cache backed by Redis.
 *
 * Each cached value is indexed under one or more tags. Invalidating a tag makes every entry
 * indexed under it unreachable (soft) or deletes those entries (hard). Methods never throw:
 * failures are reported to the logger and surface as `null` or `false`.
 *
 * @example
 * const redis = createClient();
 * await redis.connect();
 * const tagcache = new TagCache({ redis, appContext: 'user-service' });
 * await tagcache.set({ key: 'user:1', value: JSON.stringify(user), tags: ['users', 'user:1'] });
 * await tagcache.invalidate({ tags: ['user:1'] });
 */
export class TagCache {
    /** The Redis client passed as `redis`. */
    public readonly redisClient: RedisClientType;
    /** The resolved configuration. */
    public readonly cacheOptions: ResolvedCacheSettings;
    /** Receives errors caught by this instance and by TagcacheMiddleware. */
    public readonly logger: TagCacheLogger;

    private readonly operationTimeout: number | undefined;
    private readonly loads = new Map<string, Promise<LoadResult>>();

    /**
     * @throws {Error} When `config.redis` is missing.
     */
    constructor(config: TagCacheOptions) {
        if (!config?.redis) throw new Error('[TagCache] A Redis client instance is required.');

        this.redisClient = config.redis as unknown as RedisClientType;
        this.logger = config.logger ?? console;
        this.operationTimeout = isPositiveNumber(config.operationTimeout) ? config.operationTimeout : undefined;
        this.cacheOptions = {
            tagPrefix: config.tagPrefix ?? defaultConfig.TAG_KEY_PREFIX,
            cachePrefix: config.cachePrefix ?? defaultConfig.CACHE_KEY_PREFIX,
            tagTtl: getValidTtlWithFallback(config.tagTtl, defaultConfig.DEFAULT_TAG_TTL_SEC),
            cacheTtl: getValidTtlWithFallback(config.cacheTtl, defaultConfig.DEFAULT_CACHE_TTL_SEC),
            appContext: config.appContext ?? defaultConfig.APP_CONTEXT,
            sizeGuard: isPositiveNumber(config.sizeGuard) ? config.sizeGuard : defaultConfig.SIZE_GUARD_KB,
            deleteCacheKeys: config.deleteCacheKeys ?? defaultConfig.DELETE_CACHE_KEYS,
            tagIndexMaintenanceMode: config.tagIndexMaintenanceMode === 'lazy' ? 'lazy' : defaultConfig.TAG_INDEX_MAINTENANCE_MODE,
        };
    }

    /**
     * Reads a cached value, provided it has not expired and still belongs to every tag in `tags`.
     *
     * @returns The cached string, or `null` on a miss, invalidation, expiry or error.
     * @example
     * const json = await tagcache.get({ key: 'user:1', tags: ['users', 'user:1'] });
     */
    public async get({ key, tags, appContext }: CacheFetchOptions): Promise<string | null> {
        return this.guard('get', null, async () => {
            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, context);

            const batch = this.redisClient.multi();
            batch.get(cacheKey);
            const now = Date.now();
            const scoreIndices = queueMembershipChecks(batch, tagKeys, cacheKey, now, 1, this.cacheOptions.tagIndexMaintenanceMode);
            const results = await batch.exec();

            const value = results?.[0] as unknown as string | null | undefined;
            if (value === null || value === undefined) return null;

            return isMemberOfAll(results as unknown[], scoreIndices, now) ? value : null;
        });
    }

    /**
     * Stores a value under `key` and indexes it under every tag in `tags`.
     *
     * The value and its index entries are written atomically. Expired index entries of the
     * affected tags are pruned in the same step, and tag indexes are kept alive at least as long
     * as the entry (`max(tagTtl, cacheTtl)`).
     *
     * @returns `true` when written; `false` on error, or when `ifTagVersions` is given and one of
     *   the tags was invalidated after that snapshot was taken.
     * @example
     * await tagcache.set({ key: 'user:1', value: JSON.stringify(user), tags: ['users'], cacheTtl: 600 });
     */
    public async set({ key, value, tags, cacheTtl, tagTtl, appContext, ifTagVersions }: CacheStoreOptions): Promise<boolean> {
        return this.guard('set', false, async () => {
            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, context);

            const entryTtl = getValidTtlWithFallback(cacheTtl, this.cacheOptions.cacheTtl);
            const tagIndexTtl = Math.max(getValidTtlWithFallback(tagTtl, this.cacheOptions.tagTtl), entryTtl);

            const versionKeys: string[] = [];
            const expectedVersions: string[] = [];
            if (ifTagVersions) {
                for (const tagKey of tagKeys) {
                    const versionKey = formatTagVersionKey(tagKey);
                    const expected = ifTagVersions.versions[versionKey];
                    if (expected === undefined) continue;
                    versionKeys.push(versionKey);
                    expectedVersions.push(expected);
                }
            }

            const now = Date.now();
            const reply = await evalSetScript(this.redisClient, {
                keys: [cacheKey, ...tagKeys, ...versionKeys],
                arguments: [
                    typeof value === 'string' ? value : String(value),
                    String(entryTtl),
                    String(tagIndexTtl * 1000),
                    String(now),
                    String(now + entryTtl * 1000),
                    String(tagKeys.length),
                    ...expectedVersions,
                ],
            });
            return Number(reply) === 1;
        });
    }

    /**
     * Returns the cached value for `key`, or calls `load()`, caches its result and returns it.
     *
     * Concurrent calls for the same key and namespace in this process share one `load()` call,
     * so a popular entry expiring or being invalidated does not send every caller to the database.
     * The write is race-safe: if a tag is invalidated while `load()` runs, the result is returned
     * but not cached, and callers that were waiting load again themselves.
     *
     * @throws Rejects only when `load()` rejects; every caller sharing that call receives the error.
     * @example
     * const json = await tagcache.getOrSet({
     *   key: 'products:all',
     *   tags: ['products'],
     *   load: async () => JSON.stringify(await db.products.findMany()),
     * });
     */
    public async getOrSet(options: CacheGetOrSetOptions): Promise<string> {
        const cached = await this.get(options);
        if (cached !== null) return cached;

        const loadKey = `${options.appContext ?? this.cacheOptions.appContext}\n${String(options.key).trim().toLowerCase()}`;
        const pending = this.loads.get(loadKey);
        if (pending) {
            const shared = await pending;
            return shared.cached ? shared.value : (await this.loadAndStore(options)).value;
        }

        const load = this.loadAndStore(options);
        this.loads.set(loadKey, load);
        try {
            return (await load).value;
        } finally {
            this.loads.delete(loadKey);
        }
    }

    /**
     * Invalidates every entry indexed under any of `tags`.
     *
     * Soft invalidation (`deleteCacheKeys: false`) deletes the tag indexes in a single round trip;
     * the cached values become unreachable and expire on their own. Hard invalidation also deletes
     * the cached values. Either way each tag gets a new version token, so writes based on a
     * `getTagVersions()` snapshot taken earlier are rejected.
     *
     * @returns `true` on success, `false` on error.
     * @example
     * await tagcache.invalidate({ tags: ['user:1'], deleteCacheKeys: false });
     */
    public async invalidate({ tags, deleteCacheKeys, appContext }: CacheInvalidationOptions): Promise<boolean> {
        return this.guard('invalidate', false, async () => {
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);
            const hard = typeof deleteCacheKeys === 'boolean' ? deleteCacheKeys : this.cacheOptions.deleteCacheKeys;

            const batch = this.redisClient.multi();
            if (hard) {
                for (const tagKey of tagKeys) batch.zRange(tagKey, 0, -1);
            }
            batch.unlink(tagKeys);
            for (const tagKey of tagKeys) {
                batch.set(formatTagVersionKey(tagKey), createVersionToken(), { EX: this.versionTtl });
            }
            const results = await batch.exec();
            if (!hard) return true;

            if (!results) throw new Error('Failed to read tag set members from Redis.');
            const cacheKeys = [...new Set((results.slice(0, tagKeys.length) as unknown as string[][]).flat())];
            if (cacheKeys.length) {
                const deleteBatch = this.redisClient.multi();
                for (let i = 0; i < cacheKeys.length; i += UNLINK_BATCH_SIZE) {
                    deleteBatch.unlink(cacheKeys.slice(i, i + UNLINK_BATCH_SIZE));
                }
                await deleteBatch.exec();
            }
            return true;
        });
    }

    /**
     * Checks whether `key` is indexed, unexpired, under every tag in `tags`.
     *
     * @returns `true` if it belongs to all of them, `false` otherwise or on error.
     */
    public async isMember({ key, tags, appContext }: IsMemberOptions): Promise<boolean> {
        return this.guard('isMember', false, async () => {
            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, context);

            const batch = this.redisClient.multi();
            const now = Date.now();
            const scoreIndices = queueMembershipChecks(batch, tagKeys, cacheKey, now, 0, this.cacheOptions.tagIndexMaintenanceMode);
            const results = await batch.exec();

            if (!results?.length) return false;
            return isMemberOfAll(results as unknown[], scoreIndices, now);
        });
    }

    /**
     * Deletes a single cached value. Its tag index entries are pruned later.
     *
     * @returns `true` on success (including when the key did not exist), `false` on error.
     */
    public async delete({ key, appContext }: CacheDeleteOptions): Promise<boolean> {
        return this.guard('delete', false, async () => {
            await this.redisClient.unlink(formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext));
            return true;
        });
    }

    /**
     * Snapshots the version tokens of `tags`. Take it before loading the data you are about to
     * cache and pass it to `set({ ifTagVersions })`: if a tag is invalidated while you load, the
     * now-stale value is not written. `getOrSet()` does this for you.
     *
     * Tags without a token get one, so the snapshot never contains an empty version. A token that
     * later disappears (expiry, eviction, flush) therefore never matches, and the write is skipped
     * instead of slipping through.
     *
     * @returns The snapshot, or `null` on error.
     * @example
     * const versions = await tagcache.getTagVersions({ tags: ['users'] });
     * const users = await db.users.findMany();
     * if (versions) await tagcache.set({ key: 'users', value: JSON.stringify(users), tags: ['users'], ifTagVersions: versions });
     */
    public async getTagVersions({ tags, appContext }: TagVersionsOptions): Promise<TagVersions | null> {
        return this.guard('getTagVersions', null, async () => {
            const versionKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext).map(formatTagVersionKey);

            const batch = this.redisClient.multi();
            for (const versionKey of versionKeys) {
                batch.set(versionKey, createVersionToken(), { NX: true, EX: this.versionTtl });
                batch.get(versionKey);
            }
            const results = (await batch.exec()) as unknown[];

            const versions: Record<string, string> = {};
            versionKeys.forEach((versionKey, i) => {
                const token = results?.[i * 2 + 1];
                if (token === null || token === undefined) throw new Error(`Missing version token for ${versionKey}.`);
                versions[versionKey] = String(token);
            });
            return { versions };
        });
    }

    /** Lifetime of version tokens; only needs to outlive in-flight requests that hold a snapshot. */
    private get versionTtl(): number {
        return Math.max(this.cacheOptions.tagTtl, this.cacheOptions.cacheTtl);
    }

    /**
     * Runs a Redis operation with the shared error policy: checks the client is ready, applies
     * `operationTimeout`, and turns any failure into a logged `fallback` instead of a rejection.
     */
    private async guard<T>(name: string, fallback: T, operation: () => Promise<T>): Promise<T> {
        try {
            ensureRedisClientIsReady(this.redisClient);
            const result = operation();
            return await (this.operationTimeout === undefined ? result : withTimeout(result, this.operationTimeout));
        } catch (error) {
            this.logger.error(`[TagCache] ${name}() failed:`, error);
            return fallback;
        }
    }

    /** Snapshots tag versions, runs `load()` and stores its result if no tag was invalidated meanwhile. */
    private async loadAndStore({ load, ...entry }: CacheGetOrSetOptions): Promise<LoadResult> {
        const versions = await this.getTagVersions(entry);
        const value = await load();
        const cached = versions !== null && (await this.set({ ...entry, value, ifTagVersions: versions }));
        return { value, cached };
    }
}

interface LoadResult {
    value: string;
    /** Whether `value` was written to the cache, i.e. is still valid for callers that arrived later. */
    cached: boolean;
}

/** A new random tag version token. */
function createVersionToken(): string {
    return randomBytes(9).toString('base64url');
}

/** Narrows `value` to a finite number greater than zero. */
function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Rejects if `promise` has not settled within `ms`. A late rejection of `promise` is swallowed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${ms}ms`)), ms);
    });
    promise.catch(() => undefined);
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True when every ZSCORE reply at `scoreIndices` is an expiry later than `now`. */
function isMemberOfAll(results: unknown[], scoreIndices: number[], now: number): boolean {
    return scoreIndices.every((index) => {
        const score = results[index];
        return score !== null && score !== undefined && Number(score) > now;
    });
}

/**
 * Queues, for each tag, a prune of expired entries (strict mode only) and a ZSCORE of `cacheKey`.
 * Returns the reply indices of the ZSCOREs, given `offset` commands already queued.
 */
function queueMembershipChecks(batch: RedisMulti, tagKeys: string[], cacheKey: string, now: number, offset: number, mode: ResolvedCacheSettings['tagIndexMaintenanceMode']): number[] {
    const scoreIndices: number[] = [];
    let index = offset;
    for (const tagKey of tagKeys) {
        if (mode === 'strict') {
            batch.zRemRangeByScore(tagKey, 0, now);
            index++;
        }
        batch.zScore(tagKey, cacheKey);
        scoreIndices.push(index++);
    }
    return scoreIndices;
}

/** Runs SET_SCRIPT via EVALSHA, falling back to EVAL when Redis has not cached the script yet. */
async function evalSetScript(client: RedisClientType, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    try {
        return await client.evalSha(SET_SCRIPT_SHA, options);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('NOSCRIPT')) return client.eval(SET_SCRIPT, options);
        throw error;
    }
}
