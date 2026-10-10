import { describe, it, expect } from 'vitest';
import {
    expandTagHierarchy,
    InvalidInputError,
    sanitizeCacheKey,
    sanitizeTags,
    formatPrefixedKey,
    formatTagKeys,
    formatTagVersionKey,
    getValidTtlWithFallback,
} from '../src/utils/tagcache-utils.js';

describe('TagCache Utils', () => {
    describe('sanitizeCacheKey', () => {
        it('should trim and lowercase the key', () => {
            expect(sanitizeCacheKey('  MY-KEY  ')).toBe('my-key');
        });

        it('should throw error for invalid keys', () => {
            expect(() => sanitizeCacheKey('')).toThrow(InvalidInputError);
            expect(() => sanitizeCacheKey('')).toThrow('Invalid key');
            expect(() => sanitizeCacheKey('   ')).toThrow('Invalid key');
            // @ts-expect-error testing invalid input
            expect(() => sanitizeCacheKey(null)).toThrow('Invalid key');
        });
    });

    describe('sanitizeTags', () => {
        it('should deduplicate and normalize tags', () => {
            expect(sanitizeTags([' User ', 'USER', 'admin'])).toEqual(['user', 'admin']);
        });

        it('should throw error for empty or invalid tags', () => {
            expect(() => sanitizeTags([])).toThrow('Tags must be a non-empty array');
            // @ts-expect-error testing invalid input
            expect(() => sanitizeTags(null)).toThrow('Tags must be a non-empty array');
            expect(() => sanitizeTags(['ok', ' '])).toThrow('Invalid key');
        });
    });

    describe('formatPrefixedKey', () => {
        it('should format key with appContext and prefix', () => {
            expect(formatPrefixedKey(' Key ', 'p:', 'app')).toBe('app:p:key');
        });
    });

    describe('formatTagKeys', () => {
        it('should format multiple tags correctly', () => {
            expect(formatTagKeys(['a', 'B', 'b'], 't:', 'app')).toEqual(['app:t:a', 'app:t:b']);
        });
    });

    describe('expandTagHierarchy', () => {
        it('adds every ancestor once', () => {
            expect(expandTagHierarchy(['tenant:42:users', 'tenant:42:orders', 'flat'], ':')).toEqual([
                'tenant:42:users', 'tenant', 'tenant:42', 'tenant:42:orders', 'flat',
            ]);
        });

        it('supports multi-character separators and ignores leading separators', () => {
            expect(expandTagHierarchy(['a::b::c', '::x'], '::')).toEqual(['a::b::c', 'a', 'a::b', '::x']);
        });
    });

    describe('formatTagVersionKey', () => {
        it('appends an uppercase suffix that no sanitized tag can produce', () => {
            const versionKey = formatTagVersionKey('app:t:users');
            expect(versionKey).toBe('app:t:users:VERSION');
            expect(formatTagKeys(['users:version'], 't:', 'app')[0]).not.toBe(versionKey);
        });
    });

    describe('getValidTtlWithFallback', () => {
        it('should return ttl if it is a positive integer', () => {
            expect(getValidTtlWithFallback(100, 60)).toBe(100);
        });

        it('should return fallback otherwise', () => {
            for (const ttl of [undefined, -1, 0, 1.5, Number.NaN, Infinity]) {
                expect(getValidTtlWithFallback(ttl, 60)).toBe(60);
            }
        });
    });
});
