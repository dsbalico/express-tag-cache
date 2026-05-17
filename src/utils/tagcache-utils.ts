import { type RedisClientType } from 'redis';

export function sanitizeCacheKey(key: string): string {
	if (!key || typeof key !== "string") throw new Error("Invalid key");
	return key.trim().toLowerCase();
}

export function sanitizeTags(tags: string[]): string[] {
	if (!Array.isArray(tags) || tags.length === 0) throw new Error('Tags must be a non-empty array');
	return [...new Set(tags.map(sanitizeCacheKey))];
}

export function formatPrefixedKey(key: string, prefix: string, appContext: string): string {
	return `${appContext}:${prefix}${sanitizeCacheKey(key)}`;
}

export function formatTagKeys(tags: string[], prefix: string, appContext: string): string[] {
	const sanitizedTags = sanitizeTags(tags);
	return sanitizedTags.map((tag) => formatPrefixedKey(tag, prefix, appContext));
}

export function getValidTtlWithFallback(ttlValue: number | undefined, fallbackTtl: number): number {
	return ttlValue !== undefined && ttlValue > 0 ? ttlValue : fallbackTtl;
}

export function ensureRedisClientIsReady(redisClient: RedisClientType): void {
	const isReady = redisClient.isReady ?? true;
	const isOpen = redisClient.isOpen ?? true;

	if (!isReady || !isOpen) throw new Error('[TagCache] Redis client is not connected or not ready.');
}
