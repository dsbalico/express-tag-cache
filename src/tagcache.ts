import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import defaultConfig from './config/default.js';
import {
    ensureRedisClientIsReady,
    formatPrefixedKey,
    formatTagKeys,
    getValidTtlWithFallback,
} from './utils/tagcache-utils.js';
import type {
    CacheDeleteOptions,
    CacheFetchOptions,
    CacheInvalidationOptions,
    CacheStoreOptions,
    IsMemberOptions,
    ResolvedCacheSettings,
    TagCacheLogger,
    TagCacheOptions,
} from './types/tagcache.js';

type RedisMulti = ReturnType<RedisClientType['multi']>;

/**
 * Atomically writes a value and its tag index entries.
 *
 * KEYS: [1] value key, [2..n+1] tag index keys.
 * ARGV: [1] value, [2] value TTL (s), [3] tag index TTL (ms), [4] now (ms), [5] entry expiry (ms), [6] n.
 *
 * Prunes expired index entries, adds the entry, and only ever extends the index TTL, so a
 * short-lived write cannot cut a long-lived entry's index short. Returns 1.
 */
const SET_SCRIPT = `
local n = tonumber(ARGV[6])
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

    /**
     * @throws {Error} When `config.redis` is missing.
     */
    constructor(config: TagCacheOptions) {
        if (!config?.redis) throw new Error('[TagCache] A Redis client instance is required.');

        this.redisClient = config.redis as unknown as RedisClientType;
        this.logger = config.logger ?? console;
        this.cacheOptions = {
            tagPrefix: config.tagPrefix ?? defaultConfig.TAG_KEY_PREFIX,
            cachePrefix: config.cachePrefix ?? defaultConfig.CACHE_KEY_PREFIX,
            tagTtl: getValidTtlWithFallback(config.tagTtl, defaultConfig.DEFAULT_TAG_TTL_SEC),
            cacheTtl: getValidTtlWithFallback(config.cacheTtl, defaultConfig.DEFAULT_CACHE_TTL_SEC),
            appContext: config.appContext ?? defaultConfig.APP_CONTEXT,
            sizeGuard: Number.isFinite(config.sizeGuard) && (config.sizeGuard as number) > 0 ? (config.sizeGuard as number) : defaultConfig.SIZE_GUARD_KB,
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
        try {
            ensureRedisClientIsReady(this.redisClient);

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
        } catch (error) {
            this.logger.error('[TagCache] get() failed:', error);
            return null;
        }
    }

    /**
     * Stores a value under `key` and indexes it under every tag in `tags`.
     *
     * The value and its index entries are written atomically. Expired index entries of the
     * affected tags are pruned in the same step, and tag indexes are kept alive at least as long
     * as the entry (`max(tagTtl, cacheTtl)`).
     *
     * @returns `true` when written, `false` on error.
     * @example
     * await tagcache.set({ key: 'user:1', value: JSON.stringify(user), tags: ['users'], cacheTtl: 600 });
     */
    public async set({ key, value, tags, cacheTtl, tagTtl, appContext }: CacheStoreOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, context);

            const entryTtl = getValidTtlWithFallback(cacheTtl, this.cacheOptions.cacheTtl);
            const tagIndexTtl = Math.max(getValidTtlWithFallback(tagTtl, this.cacheOptions.tagTtl), entryTtl);

            const now = Date.now();
            const reply = await evalSetScript(this.redisClient, {
                keys: [cacheKey, ...tagKeys],
                arguments: [
                    typeof value === 'string' ? value : String(value),
                    String(entryTtl),
                    String(tagIndexTtl * 1000),
                    String(now),
                    String(now + entryTtl * 1000),
                    String(tagKeys.length),
                ],
            });
            return Number(reply) === 1;
        } catch (error) {
            this.logger.error('[TagCache] set() failed:', error);
            return false;
        }
    }

    /**
     * Invalidates every entry indexed under any of `tags`.
     *
     * Soft invalidation (`deleteCacheKeys: false`) deletes the tag indexes; the cached values become
     * unreachable and expire on their own. Hard invalidation also deletes the cached values.
     *
     * @returns `true` on success, `false` on error.
     * @example
     * await tagcache.invalidate({ tags: ['user:1'], deleteCacheKeys: false });
     */
    public async invalidate({ tags, deleteCacheKeys, appContext }: CacheInvalidationOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);
            const hard = typeof deleteCacheKeys === 'boolean' ? deleteCacheKeys : this.cacheOptions.deleteCacheKeys;

            const batch = this.redisClient.multi();
            for (const tagKey of tagKeys) batch.zRange(tagKey, 0, -1);
            batch.unlink(tagKeys);
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
        } catch (error) {
            this.logger.error('[TagCache] invalidate() failed:', error);
            return false;
        }
    }

    /**
     * Checks whether `key` is indexed, unexpired, under every tag in `tags`.
     *
     * @returns `true` if it belongs to all of them, `false` otherwise or on error.
     */
    public async isMember({ key, tags, appContext }: IsMemberOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, context);

            const batch = this.redisClient.multi();
            const now = Date.now();
            const scoreIndices = queueMembershipChecks(batch, tagKeys, cacheKey, now, 0, this.cacheOptions.tagIndexMaintenanceMode);
            const results = await batch.exec();

            if (!results?.length) return false;
            return isMemberOfAll(results as unknown[], scoreIndices, now);
        } catch (error) {
            this.logger.error('[TagCache] isMember() failed:', error);
            return false;
        }
    }

    /**
     * Deletes a single cached value. Its tag index entries are pruned later.
     *
     * @returns `true` on success (including when the key did not exist), `false` on error.
     */
    public async delete({ key, appContext }: CacheDeleteOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);
            await this.redisClient.unlink(formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext));
            return true;
        } catch (error) {
            this.logger.error('[TagCache] delete() failed:', error);
            return false;
        }
    }
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
