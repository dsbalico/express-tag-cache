import { describe, it, expect } from 'vitest';
import { 
    sanitizeCacheKey, 
    sanitizeTags, 
    formatPrefixedKey, 
    formatTagKeys, 
    getValidTtlWithFallback 
} from '../src/utils/tagcache-utils.js';

describe('TagCache Utils', () => {
    describe('sanitizeCacheKey', () => {
        it('should trim and lowercase the key', () => {
            expect(sanitizeCacheKey('  MY-KEY  ')).toBe('my-key');
        });

        it('should throw error for invalid keys', () => {
            expect(() => sanitizeCacheKey('')).toThrow('Invalid key');
            // @ts-ignore
            expect(() => sanitizeCacheKey(null)).toThrow('Invalid key');
        });
    });

    describe('sanitizeTags', () => {
        it('should deduplicate and normalize tags', () => {
            const tags = [' User ', 'USER', 'admin'];
            expect(sanitizeTags(tags)).toEqual(['user', 'admin']);
        });

        it('should throw error for empty or invalid tags', () => {
            expect(() => sanitizeTags([])).toThrow('Tags must be a non-empty array');
            // @ts-ignore
            expect(() => sanitizeTags(null)).toThrow('Tags must be a non-empty array');
        });
    });

    describe('formatPrefixedKey', () => {
        it('should format key with appContext and prefix', () => {
            expect(formatPrefixedKey('key', 'p:', 'app')).toBe('app:p:key');
        });
    });

    describe('formatTagKeys', () => {
        it('should format multiple tags correctly', () => {
            expect(formatTagKeys(['a', 'b'], 't:', 'app')).toEqual(['app:t:a', 'app:t:b']);
        });
    });

    describe('getValidTtlWithFallback', () => {
        it('should return ttl if valid', () => {
            expect(getValidTtlWithFallback(100, 60)).toBe(100);
        });

        it('should return fallback if ttl is undefined or <= 0', () => {
            expect(getValidTtlWithFallback(undefined, 60)).toBe(60);
            expect(getValidTtlWithFallback(-1, 60)).toBe(60);
            expect(getValidTtlWithFallback(0, 60)).toBe(60);
        });
    });
});
