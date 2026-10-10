import { createHash, randomBytes } from 'node:crypto';
import type { RedisClientType } from 'redis';
import defaultConfig from './config/default.js';
import { CircuitBreaker } from './utils/circuit-breaker.js';
import {
    emitEvent,
    ensureRedisClientIsReady,
    expandTagHierarchy,
    formatPrefixedKey,
    formatTagFenceKey,
    formatTagKeys,
    formatTagVersionKey,
    getValidTtlWithFallback,
    InvalidInputError,
    sanitizeTags,
} from './utils/tagcache-utils.js';
import type {
    CacheDeleteOptions,
    CacheFetchOptions,
    CacheGetOrSetOptions,
    CacheInvalidationOptions,
    CacheLeaseOptions,
    CacheLeaseReleaseOptions,
    CacheLookupResult,
    CacheStoreOptions,
    IsMemberOptions,
    ResolvedCacheSettings,
    TagCacheEvent,
    TagCacheLogger,
    TagCacheOptions,
    TagVersions,
    TagVersionsOptions,
} from './types/tagcache.js';

type RedisMulti = ReturnType<RedisClientType['multi']>;

/**
 * Atomically writes a value and its tag index entries.
 *
 * KEYS: [1] value key, [2..n+1] tag index keys, [n+2..2n+1] their replica-lag fence keys,
 *       [2n+2..] tag version keys to verify.
 * ARGV: [1] value, [2] value TTL (s), [3] tag index TTL (ms), [4] prune index entries scored at or
 *       below this (ms), [5] entry expiry (ms), [6] n, [7..] expected tag versions.
 *
 * Returns without writing: 2 when a tag is fenced after a recent invalidation, 0 when a tag
 * version differs from the expected one (the tag was invalidated after the caller snapshotted it).
 * Otherwise prunes expired index entries, adds the entry, only ever extends the index TTL (so a
 * short-lived write cannot cut a long-lived entry's index short), and returns 1.
 */
const SET_SCRIPT = `
local n = tonumber(ARGV[6])
for i = n + 2, 2 * n + 1 do
  if redis.call('EXISTS', KEYS[i]) == 1 then return 2 end
end
for i = 2 * n + 2, #KEYS do
  if (redis.call('GET', KEYS[i]) or '') ~= ARGV[i + 5 - 2 * n] then return 0 end
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

/** Deletes a lease only if it still holds the caller's token. KEYS: [1] lease key. ARGV: [1] token. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

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
    /** The `onEvent` hook, also used by TagcacheMiddleware. */
    public readonly onEvent: ((event: TagCacheEvent) => void) | undefined;

    private readonly operationTimeout: number | undefined;
    private readonly replicaLagMs: number | undefined;
    private readonly tagSeparator: string | undefined;
    private readonly ttlJitter: number | undefined;
    private readonly breaker: CircuitBreaker | undefined;
    private readonly retryMaxDelayMs: number | undefined;
    /** Invalidations waiting to be retried, by identity. */
    private readonly queuedInvalidations = new Map<string, QueuedInvalidation>();
    /** How many queued invalidations cover each tag index key; reads of these tags are misses. */
    private readonly blockedTagKeys = new Map<string, number>();
    private readonly backgroundPurge: boolean;
    private readonly staleMs: number;
    private retryTimer: NodeJS.Timeout | undefined;
    private retryAttempt = 0;
    private readonly loads = new Map<string, Promise<LoadResult>>();

    /**
     * @throws {Error} When `config.redis` is missing.
     */
    constructor(config: TagCacheOptions) {
        if (!config?.redis) throw new Error('[TagCache] A Redis client instance is required.');

        this.redisClient = config.redis as unknown as RedisClientType;
        this.logger = config.logger ?? console;
        this.onEvent = typeof config.onEvent === 'function' ? config.onEvent : undefined;
        this.operationTimeout = isPositiveNumber(config.operationTimeout) ? config.operationTimeout : undefined;
        this.replicaLagMs = isPositiveNumber(config.replicaLagMs) ? Math.ceil(config.replicaLagMs) : undefined;
        this.ttlJitter = isPositiveNumber(config.ttlJitter) && config.ttlJitter < 1 ? config.ttlJitter : undefined;
        this.breaker = this.createBreaker(config.circuitBreaker);
        this.backgroundPurge = config.backgroundPurge === true;
        this.staleMs = getValidTtlWithFallback(config.staleTtl, 0) * 1000;
        const retry = config.retryInvalidations;
        this.retryMaxDelayMs = retry ? (retry !== true && isPositiveNumber(retry.maxDelayMs) ? retry.maxDelayMs : 30_000) : undefined;
        this.tagSeparator = config.hierarchicalTags === true ? ':' : config.hierarchicalTags ? config.hierarchicalTags.separator || undefined : undefined;
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
    public async get(options: CacheFetchOptions): Promise<string | null> {
        const entry = await this.guard('get', null, () => this.read(options));
        return entry && !entry.stale ? entry.value : null;
    }

    /**
     * Like `get()`, but also returns entries that have expired within the last `staleTtl` seconds,
     * marked `stale`. Entries whose tags were invalidated are never returned.
     *
     * @returns The entry, or `null` on a miss, invalidation, expiry beyond `staleTtl`, or error.
     */
    public async lookup(options: CacheFetchOptions): Promise<CacheLookupResult | null> {
        return this.guard('lookup', null, () => this.read(options));
    }

    /**
     * Takes a short exclusive lease on `key`, shared by every instance using this Redis, so that only
     * one of them refreshes an entry at a time. Release it with `releaseLease()`; otherwise it
     * expires after `ttlMs`.
     *
     * @returns A token to release the lease with, or `null` if another caller holds it or on error.
     */
    public async acquireLease({ key, ttlMs, appContext }: CacheLeaseOptions): Promise<string | null> {
        return this.guard('acquireLease', null, async () => {
            const token = createVersionToken();
            const reply = await this.redisClient.set(this.leaseKey(key, appContext), token, { NX: true, PX: isPositiveNumber(ttlMs) ? Math.ceil(ttlMs) : 10_000 });
            return reply === null ? null : token;
        });
    }

    /**
     * Releases a lease taken with `acquireLease()`, if it is still held with `token`.
     *
     * @returns `true` if this call released it.
     */
    public async releaseLease({ key, token, appContext }: CacheLeaseReleaseOptions): Promise<boolean> {
        return this.guard('releaseLease', false, async () => {
            const reply = await evalScript(this.redisClient, RELEASE_SCRIPT, RELEASE_SCRIPT_SHA, { keys: [this.leaseKey(key, appContext)], arguments: [token] });
            return Number(reply) === 1;
        });
    }

    /**
     * Stores a value under `key` and indexes it under every tag in `tags`.
     *
     * The value and its index entries are written atomically. Expired index entries of the
     * affected tags are pruned in the same step, and tag indexes are kept alive at least as long
     * as the entry (`max(tagTtl, cacheTtl)`).
     *
     * @returns `true` when written; `false` on error, when `ifTagVersions` is given and one of the
     *   tags was invalidated after that snapshot was taken, or while a tag is fenced (`replicaLagMs`).
     * @example
     * await tagcache.set({ key: 'user:1', value: JSON.stringify(user), tags: ['users'], cacheTtl: 600 });
     */
    public async set({ key, value, tags, cacheTtl, tagTtl, appContext, ifTagVersions }: CacheStoreOptions): Promise<boolean> {
        return this.guard('set', false, async () => {
            const context = appContext ?? this.cacheOptions.appContext;
            const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
            const tagKeys = this.indexKeys(tags, context);

            const entryTtl = this.jitter(getValidTtlWithFallback(cacheTtl, this.cacheOptions.cacheTtl));
            const retainedTtl = entryTtl + this.staleMs / 1000;
            const tagIndexTtl = Math.max(getValidTtlWithFallback(tagTtl, this.cacheOptions.tagTtl), retainedTtl);

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
            const reply = await evalScript(this.redisClient, SET_SCRIPT, SET_SCRIPT_SHA, {
                keys: [cacheKey, ...tagKeys, ...tagKeys.map(formatTagFenceKey), ...versionKeys],
                arguments: [
                    typeof value === 'string' ? value : String(value),
                    String(retainedTtl),
                    String(tagIndexTtl * 1000),
                    String(now - this.staleMs),
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
     * With `staleWhileRevalidate`, an entry that expired within that window is returned at once and
     * refreshed in the background by a single caller across all instances. With `staleIfError`, an
     * entry that expired within that window is returned when `load()` fails.
     *
     * @throws Rejects only when `load()` rejects (and no stale value may be used instead); every
     *   caller sharing that call receives the error.
     * @example
     * const json = await tagcache.getOrSet({
     *   key: 'products:all',
     *   tags: ['products'],
     *   load: async () => JSON.stringify(await db.products.findMany()),
     * });
     */
    public async getOrSet(options: CacheGetOrSetOptions): Promise<string> {
        const revalidateMs = getValidTtlWithFallback(options.staleWhileRevalidate, 0) * 1000;
        const errorMs = getValidTtlWithFallback(options.staleIfError, 0) * 1000;
        const entry = revalidateMs || errorMs
            ? await this.lookup(options)
            : await this.get(options).then((value) => (value === null ? null : { value, expiresAt: Infinity, stale: false }));

        if (entry && !entry.stale) {
            this.emit({ type: 'hit', key: options.key, source: 'redis' });
            return entry.value;
        }
        const age = entry ? Date.now() - entry.expiresAt : Infinity;
        if (entry && age <= revalidateMs) {
            this.emit({ type: 'hit', key: options.key, source: 'stale' });
            void this.refreshInBackground(options);
            return entry.value;
        }

        this.emit({ type: 'miss', key: options.key });
        try {
            return await this.sharedLoad(options);
        } catch (error) {
            if (!entry || age > errorMs) throw error;
            this.logger.error('[TagCache] getOrSet() load failed; serving the stale value:', error);
            this.emit({ type: 'hit', key: options.key, source: 'stale' });
            return entry.value;
        }
    }

    /**
     * Invalidates every entry indexed under any of `tags`.
     *
     * Soft invalidation (`deleteCacheKeys: false`) deletes the tag indexes in a single round trip;
     * the cached values become unreachable and expire on their own. Hard invalidation also deletes
     * the cached values. Either way each tag gets a new version token, so writes based on a
     * `getTagVersions()` snapshot taken earlier are rejected, and, with `replicaLagMs`, a fence
     * that blocks all writes for the tags until replicas have caught up.
     *
     * @returns `true` on success, `false` on error. With `retryInvalidations`, a failed invalidation
     *   is queued for retry (and still returns `false`).
     * @example
     * await tagcache.invalidate({ tags: ['user:1'], deleteCacheKeys: false });
     */
    public async invalidate({ tags, deleteCacheKeys, appContext }: CacheInvalidationOptions): Promise<boolean> {
        const hard = typeof deleteCacheKeys === 'boolean' ? deleteCacheKeys : this.cacheOptions.deleteCacheKeys;
        const started = Date.now();
        let tagKeys: string[];
        try {
            tagKeys = formatTagKeys(tags, this.cacheOptions.tagPrefix, appContext ?? this.cacheOptions.appContext);
        } catch (error) {
            this.logger.error('[TagCache] invalidate() failed:', error);
            this.emit({ type: 'error', operation: 'invalidate', error });
            this.emit({ type: 'invalidate', tags, hard, ok: false, durationMs: Date.now() - started });
            return false;
        }

        const ok = await this.guard('invalidate', false, () => this.invalidateKeys(tagKeys, hard));
        const queued = !ok && this.queueInvalidation({ tags, tagKeys, hard });
        this.emit({ type: 'invalidate', tags, hard, ok, durationMs: Date.now() - started, ...(queued && { queued }) });
        return ok;
    }

    /** Number of failed invalidations waiting to be retried (`retryInvalidations`). */
    public get pendingInvalidations(): number {
        return this.queuedInvalidations.size;
    }

    /**
     * Retries queued invalidations now instead of waiting for the next scheduled attempt, e.g. before
     * shutting down.
     *
     * @returns `true` when no invalidations remain queued.
     */
    public async flushInvalidations(): Promise<boolean> {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        await this.retryQueuedInvalidations();
        return this.queuedInvalidations.size === 0;
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
            const tagKeys = this.indexKeys(tags, context);
            if (this.isBlocked(tagKeys)) return false;

            const batch = this.redisClient.multi();
            const now = Date.now();
            const scoreIndices = queueMembershipChecks(batch, tagKeys, cacheKey, now - this.staleMs, 0, this.cacheOptions.tagIndexMaintenanceMode);
            const results = await batch.exec();

            if (!results?.length) return false;
            const expiresAt = earliestExpiry(results as unknown[], scoreIndices);
            return expiresAt !== null && expiresAt > now;
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
            const versionKeys = this.indexKeys(tags, appContext ?? this.cacheOptions.appContext).map(formatTagVersionKey);

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

    /** Reads an entry and its index scores; returns it if it is still within `staleTtl` of expiring. */
    private async read({ key, tags, appContext }: CacheFetchOptions): Promise<CacheLookupResult | null> {
        const context = appContext ?? this.cacheOptions.appContext;
        const cacheKey = formatPrefixedKey(key, this.cacheOptions.cachePrefix, context);
        const tagKeys = this.indexKeys(tags, context);
        if (this.isBlocked(tagKeys)) return null;

        const batch = this.redisClient.multi();
        batch.get(cacheKey);
        const now = Date.now();
        const scoreIndices = queueMembershipChecks(batch, tagKeys, cacheKey, now - this.staleMs, 1, this.cacheOptions.tagIndexMaintenanceMode);
        const results = await batch.exec();

        const value = results?.[0] as unknown as string | null | undefined;
        if (value === null || value === undefined) return null;

        const expiresAt = earliestExpiry(results as unknown[], scoreIndices);
        if (expiresAt === null || expiresAt <= now - this.staleMs) return null;
        return { value, expiresAt, stale: expiresAt <= now };
    }

    private leaseKey(key: string, appContext: string | undefined): string {
        return `${formatPrefixedKey(key, this.cacheOptions.cachePrefix, appContext ?? this.cacheOptions.appContext)}:LEASE`;
    }

    /** Deletes the tag indexes (and, when `hard`, their entries) and issues new version tokens. */
    private async invalidateKeys(tagKeys: string[], hard: boolean): Promise<boolean> {
        const batch = this.redisClient.multi();
        if (hard) {
            for (const tagKey of tagKeys) batch.zRange(tagKey, 0, -1);
        }
        batch.unlink(tagKeys);
        for (const tagKey of tagKeys) {
            batch.set(formatTagVersionKey(tagKey), createVersionToken(), { EX: this.versionTtl });
            if (this.replicaLagMs) batch.set(formatTagFenceKey(tagKey), '1', { PX: this.replicaLagMs });
        }
        const results = await batch.exec();
        if (!hard) return true;

        if (!results) throw new Error('Failed to read tag set members from Redis.');
        const cacheKeys = [...new Set((results.slice(0, tagKeys.length) as unknown as string[][]).flat())];
        if (!cacheKeys.length) return true;

        if (this.backgroundPurge) {
            void this.purgeInBackground(cacheKeys);
            return true;
        }
        const deleteBatch = this.redisClient.multi();
        for (let i = 0; i < cacheKeys.length; i += UNLINK_BATCH_SIZE) {
            deleteBatch.unlink(cacheKeys.slice(i, i + UNLINK_BATCH_SIZE));
        }
        await deleteBatch.exec();
        return true;
    }

    /** Deletes already-unreachable entries one batch per round trip, so a huge tag never causes one big burst. */
    private async purgeInBackground(cacheKeys: string[]): Promise<void> {
        for (let i = 0; i < cacheKeys.length; i += UNLINK_BATCH_SIZE) {
            const deleted = await this.guard('purge', false, async () => {
                await this.redisClient.unlink(cacheKeys.slice(i, i + UNLINK_BATCH_SIZE));
                return true;
            });
            if (!deleted) return; // already logged; the entries expire on their own TTL
        }
    }

    /** Queues a failed invalidation for retry and blocks reads of its tags. Returns whether it was queued. */
    private queueInvalidation(invalidation: QueuedInvalidation): boolean {
        if (this.retryMaxDelayMs === undefined) return false;
        const id = `${invalidation.hard ? 'hard' : 'soft'}\n${[...invalidation.tagKeys].sort().join('\n')}`;
        if (!this.queuedInvalidations.has(id)) {
            this.queuedInvalidations.set(id, invalidation);
            for (const tagKey of invalidation.tagKeys) this.blockedTagKeys.set(tagKey, (this.blockedTagKeys.get(tagKey) ?? 0) + 1);
        }
        this.scheduleRetry();
        return true;
    }

    private scheduleRetry(): void {
        if (this.retryTimer || this.retryMaxDelayMs === undefined || !this.queuedInvalidations.size) return;
        const delay = Math.min(this.retryMaxDelayMs, 100 * 2 ** this.retryAttempt) * (0.8 + Math.random() * 0.4);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.retryQueuedInvalidations();
        }, delay);
        this.retryTimer.unref?.();
    }

    private async retryQueuedInvalidations(): Promise<void> {
        const attempt = ++this.retryAttempt;
        for (const [id, invalidation] of [...this.queuedInvalidations]) {
            const started = Date.now();
            const ok = await this.guard('invalidate', false, () => this.invalidateKeys(invalidation.tagKeys, invalidation.hard));
            this.emit({ type: 'invalidate', tags: invalidation.tags, hard: invalidation.hard, ok, durationMs: Date.now() - started, attempt });
            if (!ok) continue;
            this.queuedInvalidations.delete(id);
            for (const tagKey of invalidation.tagKeys) {
                const remaining = (this.blockedTagKeys.get(tagKey) ?? 1) - 1;
                if (remaining > 0) this.blockedTagKeys.set(tagKey, remaining);
                else this.blockedTagKeys.delete(tagKey);
            }
        }
        if (!this.queuedInvalidations.size) this.retryAttempt = 0;
        this.scheduleRetry();
    }

    /** Whether any of `tagKeys` has a queued invalidation, so entries under it must not be served. */
    private isBlocked(tagKeys: string[]): boolean {
        return this.blockedTagKeys.size > 0 && tagKeys.some((tagKey) => this.blockedTagKeys.has(tagKey));
    }

    /** Tag index keys an entry with `tags` belongs to: the tags themselves, plus their ancestors with `hierarchicalTags`. */
    private indexKeys(tags: string[], context: string): string[] {
        const expanded = this.tagSeparator ? expandTagHierarchy(sanitizeTags(tags), this.tagSeparator) : tags;
        return formatTagKeys(expanded, this.cacheOptions.tagPrefix, context);
    }

    /** Applies `ttlJitter` to a TTL in seconds, never going below one second. */
    private jitter(ttl: number): number {
        if (!this.ttlJitter) return ttl;
        return Math.max(1, Math.round(ttl * (1 + (Math.random() * 2 - 1) * this.ttlJitter)));
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
        if (this.breaker && !this.breaker.allow()) return fallback;
        try {
            ensureRedisClientIsReady(this.redisClient);
            const result = operation();
            const value = await (this.operationTimeout === undefined ? result : withTimeout(result, this.operationTimeout));
            this.breaker?.success();
            return value;
        } catch (error) {
            if (error instanceof InvalidInputError) this.breaker?.release();
            else this.breaker?.failure();
            this.logger.error(`[TagCache] ${name}() failed:`, error);
            this.emit({ type: 'error', operation: name, error });
            return fallback;
        }
    }

    private createBreaker(option: TagCacheOptions['circuitBreaker']): CircuitBreaker | undefined {
        if (!option) return undefined;
        const settings = option === true ? {} : option;
        const threshold = isPositiveNumber(settings.failureThreshold) ? Math.ceil(settings.failureThreshold) : 5;
        const cooldownMs = isPositiveNumber(settings.cooldownMs) ? settings.cooldownMs : 5000;
        return new CircuitBreaker(threshold, cooldownMs, (state) => {
            if (state === 'open') this.logger.error(`[TagCache] Circuit opened after ${threshold} consecutive Redis failures; skipping Redis for ${cooldownMs}ms.`);
            this.emit({ type: 'circuit', state });
        });
    }

    /** Calls `onEvent`, logging instead of propagating anything it throws. */
    private emit(event: TagCacheEvent): void {
        emitEvent(this, event);
    }

    /** Runs `load()` once for all concurrent callers of the same key in this process (see `getOrSet()`). */
    private async sharedLoad(options: CacheGetOrSetOptions): Promise<string> {
        const loadKey = this.loadKey(options);
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

    /** Refreshes an entry unless this process or, via a lease, another instance is already doing so. */
    private async refreshInBackground(options: CacheGetOrSetOptions): Promise<void> {
        if (this.loads.has(this.loadKey(options))) return;
        const token = await this.acquireLease(options);
        if (!token) return;
        try {
            await this.sharedLoad(options);
        } catch (error) {
            this.logger.error('[TagCache] Background refresh failed:', error);
            this.emit({ type: 'error', operation: 'refresh', error });
        } finally {
            await this.releaseLease({ key: options.key, token, appContext: options.appContext });
        }
    }

    private loadKey({ key, appContext }: CacheGetOrSetOptions): string {
        return `${appContext ?? this.cacheOptions.appContext}\n${String(key).trim().toLowerCase()}`;
    }

    /** Snapshots tag versions, runs `load()` and stores its result if no tag was invalidated meanwhile. */
    private async loadAndStore({ key, tags, load, cacheTtl, tagTtl, appContext }: CacheGetOrSetOptions): Promise<LoadResult> {
        const versions = await this.getTagVersions({ tags, appContext });
        const value = await load();
        const cached = versions !== null && (await this.set({ key, value, tags, cacheTtl, tagTtl, appContext, ifTagVersions: versions }));
        return { value, cached };
    }
}

interface QueuedInvalidation {
    tags: string[];
    tagKeys: string[];
    hard: boolean;
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

/** The earliest expiry among the ZSCORE replies at `scoreIndices`, or `null` if the key is missing from any index. */
function earliestExpiry(results: unknown[], scoreIndices: number[]): number | null {
    let earliest = Infinity;
    for (const index of scoreIndices) {
        const score = results[index];
        if (score === null || score === undefined) return null;
        earliest = Math.min(earliest, Number(score));
    }
    return earliest;
}

/**
 * Queues, for each tag, a prune of entries scored at or below `pruneBefore` (strict mode only) and
 * a ZSCORE of `cacheKey`. Returns the reply indices of the ZSCOREs, given `offset` commands queued.
 */
function queueMembershipChecks(batch: RedisMulti, tagKeys: string[], cacheKey: string, pruneBefore: number, offset: number, mode: ResolvedCacheSettings['tagIndexMaintenanceMode']): number[] {
    const scoreIndices: number[] = [];
    let index = offset;
    for (const tagKey of tagKeys) {
        if (mode === 'strict') {
            batch.zRemRangeByScore(tagKey, 0, pruneBefore);
            index++;
        }
        batch.zScore(tagKey, cacheKey);
        scoreIndices.push(index++);
    }
    return scoreIndices;
}

const SET_SCRIPT_SHA = sha1(SET_SCRIPT);
const RELEASE_SCRIPT_SHA = sha1(RELEASE_SCRIPT);

function sha1(script: string): string {
    return createHash('sha1').update(script).digest('hex');
}

/** Runs a script via EVALSHA, falling back to EVAL when Redis has not cached it yet. */
async function evalScript(client: RedisClientType, script: string, sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    try {
        return await client.evalSha(sha, options);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('NOSCRIPT')) return client.eval(script, options);
        throw error;
    }
}
