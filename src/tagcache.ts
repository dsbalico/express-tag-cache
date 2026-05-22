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
        };
    }

    public async get({ key, tags, appContext }: CacheFetchOptions): Promise<string | null> {
        try {
            ensureRedisClientIsReady(this.redisClient);

            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);
            const formattedTagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);

            const multiBatch = this.redisClient.multi();

            multiBatch.get(formattedCacheKey);

            formattedTagKeys.forEach((tagKey: string) => multiBatch.sIsMember(tagKey, formattedCacheKey));

            const executionResults = await multiBatch.exec() as unknown as [string | null, ...boolean[]];
            if (!executionResults?.length) return null;

            const [resultData, ...isTagValidFlags] = executionResults;
            if (!resultData) return null;

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

            for (const tagKey of formattedTagKeys) {
                multiBatch.sAdd(tagKey, formattedCacheKey);
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
            formattedTagKeys.forEach((tagKey: string) => readBatch.sMembers(tagKey));
            const keysByTag = await readBatch.exec() as unknown as string[][];

            if (!keysByTag) throw new Error('Failed to read tag set members from Redis.');

            const targetedCacheKeys = [...new Set(keysByTag.flat().filter(Boolean))];

            const deleteBatch = this.redisClient.multi();
            deleteBatch.del(formattedTagKeys);

            if (deleteCacheKeys && targetedCacheKeys.length > 0) deleteBatch.del(targetedCacheKeys);

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
            formattedTagKeys.forEach((tagKey: string) => multiBatch.sIsMember(tagKey, formattedCacheKey));
            const executionResults = await multiBatch.exec() as unknown as boolean[];

            if (!executionResults?.length) return false;

            return executionResults.every(Boolean);
        } catch (error) {
            console.error('[TagCache] isMember() failed:', error);
            return false;
        }
    }

    public async delete({ key, appContext }: CacheDeleteOptions): Promise<boolean> {
        try {
            ensureRedisClientIsReady(this.redisClient);
            const formattedCacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext);
            await this.redisClient.del(formattedCacheKey);
            return true;
        } catch (error) {
            console.error('[TagCache] delete() failed:', error);
            return false;
        }
    }
}