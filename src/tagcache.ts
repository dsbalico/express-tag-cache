import { type RedisClientType } from 'redis';
import defaultConfig from './config/default.js';
import { ensureRedisClientIsReady, formatPrefixedKey, formatTagKeys, getValidTtlWithFallback } from './utils/tagcache-utils.js';
import { CacheDeleteOptions, CacheFetchOptions, CacheInvalidationOptions, CacheStoreOptions, IsMemberOptions, ResolvedCacheSettings, TagCacheOptions } from './types/tagcache.js';

export class TagCache {
    public readonly redisClient: RedisClientType;
    public readonly cacheOptions: ResolvedCacheSettings;

    constructor(config: TagCacheOptions) {
        if (!config?.redis) throw new Error('[TagCache] A Redis client instance is required.');

        this.redisClient = config.redis;
        this.cacheOptions = {
            tagPrefix: config.tagPrefix ?? defaultConfig.TAG_KEY_PREFIX,
            cachePrefix: config.cachePrefix ?? defaultConfig.CACHE_KEY_PREFIX,
            tagTtl: config.tagTtl && config.tagTtl >= 0 ? config.tagTtl : defaultConfig.DEFAULT_TAG_TTL_SEC,
            cacheTtl: config.cacheTtl && config.cacheTtl >= 0 ? config.cacheTtl : defaultConfig.DEFAULT_CACHE_TTL_SEC,
            appContext: config.appContext ?? defaultConfig.APP_CONTEXT,
            sizeGuard: config.sizeGuard && config.sizeGuard > 0 ? config.sizeGuard : defaultConfig.SIZE_GUARD_KB,
            deleteCacheKeys: config.deleteCacheKeys ?? defaultConfig.DELETE_CACHE_KEYS,
        };
    }

    public async get({ key, tags, appContext }: CacheFetchOptions): Promise<string | null> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);
            const formattedTagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);

            const multiBatch = this.redisClient.multi();

            multiBatch.get(formattedCacheKey);

            const now = Date.now();
            formattedTagKeys.forEach((tagKey: string) => {
                multiBatch.zRemRangeByScore(tagKey, 0, now);
                multiBatch.zScore(tagKey, formattedCacheKey);
            });

            const executionResults = await multiBatch.exec();
            if (!executionResults?.length) return null;

            const resultData = executionResults[0] as unknown as string | null;
            if (!resultData) return null;

            const isTagValidFlags: boolean[] = [];
            for (let i = 0; i < formattedTagKeys.length; i++) {
                const scoreResult = executionResults[i * 2 + 2];
                isTagValidFlags.push(scoreResult !== null);
            }

            return isTagValidFlags.every(Boolean) ? resultData : null;
        } catch (error) {
            console.error('[TagCache] get() failed:', error);
            return null;
        }
    }

    public async set({ key, value, tags, cacheTtl, tagTtl, appContext }: CacheStoreOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const formattedTagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);
            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);

            const finalCacheTtl = getValidTtlWithFallback(cacheTtl, this.cacheOptions.cacheTtl);
            const finalTagTtl = getValidTtlWithFallback(tagTtl, this.cacheOptions.tagTtl);

            const multiBatch = this.redisClient.multi();
            multiBatch.set(formattedCacheKey, value, { EX: finalCacheTtl });

            const now = Date.now();
            for (const tagKey of formattedTagKeys) {
                multiBatch.zAdd(tagKey, { score: now + finalCacheTtl * 1000, value: formattedCacheKey });
                multiBatch.expire(tagKey, finalTagTtl);
            }

            await multiBatch.exec();
            return true;
        } catch (error) {
            console.error('[TagCache] set() failed:', error);
            return false;
        }
    }

    public async invalidate({ tags, deleteCacheKeys, appContext }: CacheInvalidationOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const formattedTagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext)

            const readBatch = this.redisClient.multi();
            const now = Date.now();
            formattedTagKeys.forEach((tagKey: string) => {
                readBatch.zRemRangeByScore(tagKey, 0, now);
                readBatch.zRange(tagKey, 0, -1);
            });
            const executionResults = await readBatch.exec();

            if (!executionResults) throw new Error('Failed to read tag set members from Redis.');

            const keysByTag: string[][] = [];
            for (let i = 0; i < formattedTagKeys.length; i++) {
                keysByTag.push(executionResults[i * 2 + 1] as unknown as string[]);
            }

            const targetedCacheKeys = [...new Set(keysByTag.flat().filter(Boolean))];

            const deleteBatch = this.redisClient.multi();
            const useUnlink = typeof this.redisClient.unlink === 'function';

            if (useUnlink) {
                deleteBatch.unlink(formattedTagKeys);
            } else {
                deleteBatch.del(formattedTagKeys);
            }

            const shouldDeleteCacheKeys =
                typeof deleteCacheKeys === "boolean"
                    ? deleteCacheKeys
                    : this.cacheOptions.deleteCacheKeys;

            if (shouldDeleteCacheKeys && targetedCacheKeys.length) {
                if (useUnlink) {
                    deleteBatch.unlink(targetedCacheKeys);
                } else {
                    deleteBatch.del(targetedCacheKeys);
                }
            }

            await deleteBatch.exec();
            return true;
        } catch (error) {
            console.error('[TagCache] invalidate() failed:', error);
            return false;
        }
    }

    public async isMember({ key, tags, appContext }: IsMemberOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);
            const formattedTagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);

            const multiBatch = this.redisClient.multi();
            const now = Date.now();
            formattedTagKeys.forEach((tagKey: string) => {
                multiBatch.zRemRangeByScore(tagKey, 0, now);
                multiBatch.zScore(tagKey, formattedCacheKey);
            });
            const executionResults = await multiBatch.exec();

            if (!executionResults?.length) return false;

            const isTagValidFlags: boolean[] = [];
            for (let i = 0; i < formattedTagKeys.length; i++) {
                const scoreResult = executionResults[i * 2 + 1];
                isTagValidFlags.push(scoreResult !== null);
            }

            return isTagValidFlags.every(Boolean);
        } catch (error) {
            console.error('[TagCache] isMember() failed:', error);
            return false;
        }
    }

    public async delete({ key, appContext }: CacheDeleteOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);
            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);
            if (typeof this.redisClient.unlink === 'function') {
                await this.redisClient.unlink(formattedCacheKey);
            } else {
                await this.redisClient.del(formattedCacheKey);
            }
            return true;
        } catch (error) {
            console.error('[TagCache] delete() failed:', error);
            return false;
        }
    }
}