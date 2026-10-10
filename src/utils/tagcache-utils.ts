import type { RedisClientType } from 'redis';

/**
 * Normalizes a cache key or tag: trims whitespace and lowercases it.
 *
 * @throws {Error} `Invalid key` when the input is not a string or is empty after trimming.
 */
export function sanitizeCacheKey(key: string): string {
	const sanitized = typeof key === 'string' ? key.trim().toLowerCase() : '';
	if (!sanitized) throw new Error('Invalid key');
	return sanitized;
}

/**
 * Normalizes and de-duplicates a list of tags.
 *
 * @throws {Error} When `tags` is not a non-empty array or contains an invalid tag.
 */
export function sanitizeTags(tags: string[]): string[] {
	if (!Array.isArray(tags) || tags.length === 0) throw new Error('Tags must be a non-empty array');
	return [...new Set(tags.map(sanitizeCacheKey))];
}

/**
 * Builds the Redis key `<appContext>:<prefix><sanitized key>`.
 *
 * @example formatPrefixedKey(' User:1 ', 'data:', 'app') // 'app:data:user:1'
 */
export function formatPrefixedKey(key: string, prefix: string, appContext: string): string {
	return `${appContext}:${prefix}${sanitizeCacheKey(key)}`;
}

/**
 * Builds the Redis keys of the tag indexes for `tags`, sanitized and de-duplicated.
 */
export function formatTagKeys(tags: string[], prefix: string, appContext: string): string[] {
	return sanitizeTags(tags).map((tag) => `${appContext}:${prefix}${tag}`);
}

/**
 * Returns `ttlValue` when it is a positive whole number of seconds, otherwise `fallbackTtl`.
 */
export function getValidTtlWithFallback(ttlValue: number | undefined, fallbackTtl: number): number {
	return Number.isSafeInteger(ttlValue) && (ttlValue as number) > 0 ? (ttlValue as number) : fallbackTtl;
}

/**
 * @throws {Error} When the client reports that it is closed or not ready.
 */
export function ensureRedisClientIsReady(redisClient: RedisClientType): void {
	const isReady = redisClient.isReady ?? true;
	const isOpen = redisClient.isOpen ?? true;

	if (!isReady || !isOpen) throw new Error('[TagCache] Redis client is not connected or not ready.');
}
