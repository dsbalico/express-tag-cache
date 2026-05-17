import { describe, it, expect } from 'vitest';
import { 
    bypassCache, 
    resolveTags
} from '../src/utils/tagcache-middleware-utils.js';

describe('Middleware Utils', () => {
    describe('bypassCache', () => {
        it('should return true if enable is false', () => {
            expect(bypassCache({ req: { headers: {} } as any, enable: false })).toBe(true);
        });

        it('should return true if cache-control is no-cache', () => {
            const req = { headers: { 'cache-control': 'no-cache' } } as any;
            expect(bypassCache({ req, enable: true })).toBe(true);
        });

        it('should return false if cache-control is normal', () => {
            const req = { headers: { 'cache-control': 'public, max-age=3600' } } as any;
            expect(bypassCache({ req, enable: true })).toBe(false);
        });
    });

    describe('resolveTags', () => {
        it('should resolve string tags', () => {
            const req = {} as any;
            expect(resolveTags({ req, tags: ['tag1', 'tag2'] })).toEqual(['tag1', 'tag2']);
        });

        it('should resolve function tags', () => {
            const req = { params: { id: '123' } } as any;
            const tags = [(r: any) => `user:${r.params.id}`, 'static'];
            expect(resolveTags({ req, tags })).toEqual(['user:123', 'static']);
        });

        it('should filter out empty tags', () => {
            const req = {} as any;
            expect(resolveTags({ req, tags: ['tag1', '', null as any, undefined as any] })).toEqual(['tag1']);
        });
    });
});
