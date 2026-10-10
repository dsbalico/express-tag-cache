import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
    bypassCache,
    generateCacheKey,
    isCacheableResponse,
    resolveTags,
} from '../src/utils/tagcache-middleware-utils.js';

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

describe('Middleware Utils', () => {
    describe('bypassCache', () => {
        it('should return true if enable is false', () => {
            expect(bypassCache({ req: { headers: {} } as any, enable: false })).toBe(true);
        });

        it.each(['no-cache', 'No-Store', 'max-age=0, no-cache'])('should return true for Cache-Control: %s', (value) => {
            expect(bypassCache({ req: { headers: { 'cache-control': value } } as any, enable: true })).toBe(true);
        });

        it('should return true for Pragma: no-cache in any case', () => {
            expect(bypassCache({ req: { headers: { pragma: 'No-Cache' } } as any, enable: true })).toBe(true);
        });

        it('should return false if cache-control is normal', () => {
            const req = { headers: { 'cache-control': 'public, max-age=3600' } } as any;
            expect(bypassCache({ req, enable: true })).toBe(false);
        });
    });

    describe('resolveTags', () => {
        it('should resolve string tags', () => {
            expect(resolveTags({ req: {} as any, tags: ['tag1', 'tag2'] })).toEqual(['tag1', 'tag2']);
        });

        it('should resolve function tags', () => {
            const req = { params: { id: '123' } } as any;
            expect(resolveTags({ req, tags: [(r: any) => `user:${r.params.id}`, 'static'] })).toEqual(['user:123', 'static']);
        });

        it('should drop empty and duplicate tags', () => {
            expect(resolveTags({ req: {} as any, tags: ['tag1', '', ' tag1 ', null as any, undefined as any] })).toEqual(['tag1']);
        });
    });

    describe('generateCacheKey', () => {
        const request = (overrides: Record<string, unknown> = {}) =>
            ({ method: 'GET', baseUrl: '', path: '/users/', params: { id: '1' }, query: { b: '2', a: '1' }, body: { x: 1 }, ...overrides }) as any;

        it('is unchanged from v2.2.0 for routes not mounted on a router', () => {
            expect(generateCacheKey(request())).toBe(sha256('GET:/users:{"params":{"id":"1"},"query":{"a":"1","b":"2"}}'));
        });

        it('includes the router mount path', () => {
            expect(generateCacheKey(request({ baseUrl: '/v1' }))).not.toBe(generateCacheKey(request({ baseUrl: '/v2' })));
            expect(generateCacheKey(request({ baseUrl: '/v1', path: '/' }))).toBe(generateCacheKey(request({ baseUrl: '', path: '/v1' })));
        });

        it('ignores key order', () => {
            expect(generateCacheKey(request({ query: { a: '1', b: '2' } }))).toBe(generateCacheKey(request()));
        });

        it('includes the body only for POST, PUT and PATCH', () => {
            expect(generateCacheKey(request({ body: { x: 2 } }))).toBe(generateCacheKey(request()));
            expect(generateCacheKey(request({ method: 'POST', body: { x: 2 } }))).not.toBe(generateCacheKey(request({ method: 'POST' })));
        });
    });

    describe('isCacheableResponse', () => {
        const response = (statusCode: number, headers: Record<string, unknown>) =>
            ({ statusCode, getHeader: (name: string) => headers[name.toLowerCase()] }) as any;

        it('accepts 2xx JSON responses', () => {
            expect(isCacheableResponse(response(200, { 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
        });

        it.each([
            ['non-2xx status', 404, {}],
            ['non-JSON body', 200, { 'content-type': 'text/html' }],
            ['Set-Cookie', 200, { 'set-cookie': ['sid=1'] }],
            ['Cache-Control: private', 200, { 'cache-control': 'private, max-age=60' }],
            ['Cache-Control: no-store', 200, { 'cache-control': 'no-store' }],
        ])('rejects responses with %s', (_, status, headers) => {
            expect(isCacheableResponse(response(status, { 'content-type': 'application/json', ...headers }))).toBe(false);
        });
    });
});
