import type { RedisClientType } from 'redis';
import type { TagCacheEvent, TagCacheLogger } from '../types/tagcache.js';

/** An error caused by the caller's input rather than by Redis. Never trips the circuit breaker. */
export class InvalidInputError extends Error {
	override name = 'InvalidInputError';
}

/**
 * Normalizes a cache key or tag: trims whitespace and lowercases it.
 *
 * @throws {InvalidInputError} `Invalid key` when the input is not a string or is empty after trimming.
 */
export function sanitizeCacheKey(key: string): string {
	const sanitized = typeof key === 'string' ? key.trim().toLowerCase() : '';
	if (!sanitized) throw new InvalidInputError('Invalid key');
	return sanitized;
}

/**
 * Normalizes and de-duplicates a list of tags.
 *
 * @throws {InvalidInputError} When `tags` is not a non-empty array or contains an invalid tag.
 */
export function sanitizeTags(tags: string[]): string[] {
	if (!Array.isArray(tags) || tags.length === 0) throw new InvalidInputError('Tags must be a non-empty array');
	return [...new Set(tags.map(sanitizeCacheKey))];
}

/**
 * Adds every ancestor of each tag, splitting on `separator`, and de-duplicates the result.
 *
 * @example expandTagHierarchy(['tenant:42:users'], ':') // ['tenant:42:users', 'tenant', 'tenant:42']
 */
export function expandTagHierarchy(tags: string[], separator: string): string[] {
	const expanded = new Set<string>();
	for (const tag of tags) {
		expanded.add(tag);
		for (let i = tag.indexOf(separator); i > 0; i = tag.indexOf(separator, i + separator.length)) {
			expanded.add(tag.slice(0, i));
		}
	}
	return [...expanded];
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
 * Returns the key of the invalidation counter that belongs to a tag index key.
 * Sanitized tags are lowercase, so the uppercase suffix can never collide with a tag key.
 */
export function formatTagVersionKey(tagKey: string): string {
	return `${tagKey}:VERSION`;
}

/**
 * Returns the key of the replica-lag fence that belongs to a tag index key. See
 * {@link formatTagVersionKey} for why the uppercase suffix cannot collide.
 */
export function formatTagFenceKey(tagKey: string): string {
	return `${tagKey}:FENCE`;
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

/**
 * Calls `onEvent`, logging instead of propagating anything it throws. Accepts anything shaped
 * like a TagCache, so test doubles without an `onEvent` hook work too.
 */
export function emitEvent(source: { onEvent?: (event: TagCacheEvent) => void; logger?: TagCacheLogger }, event: TagCacheEvent): void {
	if (!source.onEvent) return;
	try {
		source.onEvent(event);
	} catch (error) {
		(source.logger ?? console).error('[TagCache] onEvent handler failed:', error);
	}
}
