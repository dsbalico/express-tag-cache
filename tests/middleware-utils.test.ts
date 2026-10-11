import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
    bypassCache,
    createQueryFilter,
    generateCacheKey,
    isCacheableResponse,
    resolveTags,
    varyPreventsCaching,
} from '../src/utils/tagcache-middleware-utils.js';

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

const request = (overrides: Record<string, unknown> = {}) =>
    ({ method: 'GET', baseUrl: '', path: '/users/', params: { id: '1' }, query: { b: '2', a: '1' }, body: { x: 1 }, ...overrides }) as any;

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

        it('uses only the method and a custom key when one is given', () => {
            const key = (req: any) => String(req.query.id);
            expect(generateCacheKey(request({ path: '/a', query: { id: '1' } }), { key })).toBe(generateCacheKey(request({ path: '/b', query: { id: '1', other: 'x' } }), { key }));
            expect(generateCacheKey(request({ query: { id: '1' } }), { key })).not.toBe(generateCacheKey(request({ method: 'HEAD', query: { id: '1' } }), { key }));
            expect(generateCacheKey(request({ query: { id: '1' } }), { key })).toBe(sha256('GET:key:1'));
        });

        it('includes the vary value', () => {
            const forUser = (id: string) => generateCacheKey(request(), { vary: () => id });
            expect(forUser('alice')).not.toBe(forUser('bob'));
            expect(forUser('alice')).toBe(forUser('alice'));
        });
    });

    describe('ignoreQuery', () => {
        it('leaves ignored query parameters out of the key', () => {
            const ignoreQuery = createQueryFilter(['fbclid', 'utm_*']);
            const tracked = request({ query: { a: '1', b: '2', fbclid: 'x', utm_source: 'news', utm_medium: 'mail' } });

            expect(generateCacheKey(tracked, { ignoreQuery })).toBe(generateCacheKey(request()));
            expect(generateCacheKey(request({ query: { a: '2', b: '2' } }), { ignoreQuery })).not.toBe(generateCacheKey(request()));
        });

        it('matches exact names and trailing-* prefixes only', () => {
            const ignore = createQueryFilter(['ref', 'utm_*'])!;
            expect(['ref', 'utm_', 'utm_source'].map(ignore)).toEqual([true, true, true]);
            expect(['referrer', 'xutm_source', 'page'].map(ignore)).toEqual([false, false, false]);
        });

        it('returns no filter for an empty list', () => {
            expect(createQueryFilter(undefined)).toBeUndefined();
            expect(createQueryFilter([])).toBeUndefined();
        });
    });

    describe('isCacheableResponse', () => {
        const response = (statusCode: number, headers: Record<string, unknown>) =>
            ({ statusCode, getHeader: (name: string) => headers[name.toLowerCase()] }) as any;

        it('accepts 200 JSON responses', () => {
            expect(isCacheableResponse(response(200, { 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
        });

        it.each([
            ['non-2xx status', 404, {}],
            ['202 Accepted', 202, {}],
            ['201 Created', 201, {}],
            ['206 Partial Content', 206, {}],
            ['non-JSON body', 200, { 'content-type': 'text/html' }],
            ['Set-Cookie', 200, { 'set-cookie': ['sid=1'] }],
            ['Cache-Control: private', 200, { 'cache-control': 'private, max-age=60' }],
            ['Cache-Control: no-store', 200, { 'cache-control': 'no-store' }],
        ])('rejects responses with %s', (_, status, headers) => {
            expect(isCacheableResponse(response(status, { 'content-type': 'application/json', ...headers }))).toBe(false);
        });
    });

    describe('varyPreventsCaching', () => {
        const withVary = (vary: unknown) => ({ getHeader: (name: string) => (name === 'vary' ? vary : undefined) }) as any;

        it.each([
            [undefined, false, false],
            ['Accept-Encoding', false, false],
            ['Origin, accept-encoding', false, false],
            ['Accept', false, true],
            ['Accept-Language', false, true],
            ['Accept', true, false],
            ['*', true, true],
            [['Origin', 'Cookie'], false, true],
        ])('Vary: %j with routeVaries=%s -> %s', (vary, routeVaries, expected) => {
            expect(varyPreventsCaching(withVary(vary), routeVaries)).toBe(expected);
        });
    });
});
