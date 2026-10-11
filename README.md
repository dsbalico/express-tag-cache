# express-tag-cache

Tag-based Redis caching for Express. Cache JSON responses, then invalidate every response that shares a tag with one call, without ever serving data older than the last invalidation.

[![npm downloads](https://img.shields.io/npm/dm/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![npm version](https://img.shields.io/npm/v/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![license](https://img.shields.io/github/license/dsbalico/express-tag-cache?style=for-the-badge)](https://github.com/dsbalico/express-tag-cache/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Supported-blue?style=for-the-badge)](https://www.typescriptlang.org/)

- **Invalidate by tag**: tag responses (`products`, `product:42`), then clear them all when the data changes.
- **No stale reads after writes**: invalidation finishes before the mutation's response is sent, and a response computed from data that changed mid-request is never cached.
- **Built for traffic**: request coalescing, stale-while-revalidate, early refresh and TTL jitter keep your database calm.
- **Keeps working when things break**: timeouts, a circuit breaker, retried invalidations and stale-if-error.
- **Zero runtime dependencies**, TypeScript types included, tested against real Redis.

## Contents

[Install](#install) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Recipes](#recipes) · [Production setup](#production-setup) · [Security checklist](#security-checklist) · [Troubleshooting](#troubleshooting) · [API reference](#api-reference) · [Upgrading](#upgrading)

## Install

```bash
npm install express-tag-cache redis express
```

Requires Node.js 18+, Express 4 or 5, the [`redis`](https://www.npmjs.com/package/redis) client v4, v5 or v6, and a Redis-compatible server (Redis 4+, Valkey, Dragonfly; Redis Cluster is not supported). The package is ESM; from CommonJS use `require()` on Node 20.19+ / 22.12+, or `await import()`.

## Quick start

```typescript
import express from 'express';
import { createClient } from 'redis';
import { TagCache, TagcacheMiddleware } from 'express-tag-cache';

const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

const tagcache = new TagCache({ redis: redisClient, appContext: 'shop' });
const cacheMiddleware = new TagcacheMiddleware({ tagcache, enable: true });

const app = express();
app.use(express.json());

const products = new Map([[1, { id: 1, name: 'Desk', price: 250 }]]); // stands in for your database

// Cached, and tagged "products" and "product:<id>".
app.get('/products/:id', cacheMiddleware.cache(['products', (req) => `product:${req.params.id}`]), (req, res) => {
  const product = products.get(Number(req.params.id));
  if (!product) return void res.status(404).json({ error: 'Not found' });
  res.json(product);
});

// A successful update clears every response tagged "product:<id>" before the client gets its answer.
app.put('/products/:id', cacheMiddleware.invalidate([(req) => `product:${req.params.id}`]), (req, res) => {
  const id = Number(req.params.id);
  products.set(id, { id, ...req.body });
  res.json({ updated: true });
});

app.listen(3000);
```

The first `GET /products/1` runs the route and stores the response (`X-Cache: MISS`); the next one is served from Redis (`X-Cache: HIT`). After a successful `PUT /products/1`, the next `GET` runs the route again and returns the new data.

## How it works

**Tags.** Each cached response is indexed under its tags. Tags are strings, or functions that compute a tag from the request. Invalidating a tag invalidates every response indexed under it.

**What is cached.** A response sent with `res.json()` or `res.send()` is stored when all of these hold:
- the status is `200` and `Content-Type` is `application/json`;
- it sets no cookies and has no `Cache-Control: private` or `no-store`;
- it has no `Vary` on request headers that the cache key ignores (`Vary: Origin` and `Accept-Encoding` are fine; anything else needs the route's `vary` or `key` option);
- its body is at most `sizeGuard` KB;
- none of its tags was invalidated while the route ran.

Hits replay the stored body with status 200 and `Content-Type: application/json`; other response headers are not stored.

**The cache key** is a SHA-256 of the method, the full path (router mount path included), `req.params`, `req.query` (minus `ignoreQuery` parameters), the body for POST/PUT/PATCH, and the route's `vary` value. **Headers and cookies are not part of the key**, so per-user responses need `vary` ([recipe](#per-user-responses)). Keys and tags are trimmed and lowercased.

**Invalidation** is hard by default (`deleteCacheKeys: true`: tag indexes and cached values are deleted) or soft (`deleteCacheKeys: false`: only the tag indexes are deleted, in one round trip; values become unreachable and expire on their own). Prefer soft for tags with many entries.

**Response headers:** `X-Cache: HIT` (with `X-Cache-Key`, the Redis key), `MISS` (the route ran), `STALE` (an expired entry was served on purpose, see [high-traffic routes](#high-traffic-routes)) or `BYPASS` (the cache was skipped).

## Recipes

### Per-user responses

Add whatever the response depends on to the key with `vary`:

```typescript
app.get('/me', cacheMiddleware.cache([(req) => `user:${req.get('x-user-id')}`], { vary: (req) => req.get('x-user-id') }), (req, res) => {
  res.json({ userId: req.get('x-user-id') }); // in a real app: vary: (req) => req.user.id
});
```

### Caching outside routes

`getOrSet()` returns the cached value or runs `load()`, caches the result and returns it. Concurrent calls share one `load()`, and a value loaded while one of its tags was invalidated is returned but not cached:

```typescript
const featuredJson = await tagcache.getOrSet({
  key: 'products:featured',
  tags: ['products'],
  load: async () => JSON.stringify([...products.values()]),
});

await tagcache.invalidate({ tags: ['products'] }); // e.g. from a background job or a queue consumer
```

### Several services, one Redis

Every method takes an `appContext` to act on another service's namespace:

```typescript
const ordersCache = new TagCache({ redis: redisClient, appContext: 'orders' });

await ordersCache.invalidate({ tags: ['product:1'], appContext: 'shop' }); // clear the shop's cache from the orders service
```

### Multi-tenant data (hierarchical tags)

With `hierarchicalTags: true`, `tenant:42:reports:7` also belongs to `tenant:42:reports` and `tenant:42`, so one call clears a whole subtree. Every service using the namespace must use the same setting.

```typescript
const tenantCache = new TagCache({ redis: redisClient, appContext: 'saas', hierarchicalTags: true });

await tenantCache.set({ key: 'report:7', value: '{"id":7}', tags: ['tenant:42:reports:7'] });
await tenantCache.invalidate({ tags: ['tenant:42'] }); // everything belonging to tenant 42
```

### High-traffic routes

```typescript
const catalogCache = new TagCache({ redis: redisClient, appContext: 'catalog', staleTtl: 300, ttlJitter: 0.1 });
const catalogMiddleware = new TagcacheMiddleware({ tagcache: catalogCache, enable: true, coalesce: { timeoutMs: 2000 } });

app.get(
  '/catalog',
  catalogMiddleware.cache(['products'], { staleWhileRevalidate: 60, staleIfError: 300, earlyRefresh: true, ignoreQuery: ['utm_*', 'fbclid'] }),
  (req, res) => {
    res.json({ items: [...products.values()] });
  },
);
```

- **`coalesce`**: identical requests that miss together share one route run instead of each hitting the database. `timeoutMs` bounds the wait.
- **`staleWhileRevalidate`**: an entry that expired within the window is served at once (`X-Cache: STALE`) while one request, across all instances, refreshes it. Needs `staleTtl`.
- **`staleIfError`**: an entry that expired within the window is served instead of a 5xx, e.g. while the database is down. Needs `staleTtl`.
- **`earlyRefresh`**: popular entries are refreshed by one request shortly *before* they expire, so they never expire for everyone at once.
- **`ttlJitter`**: spreads TTLs (here ±10%) so entries written together do not expire together.
- **`ignoreQuery`**: tracking parameters do not split the cache.

Only entries that expired by time are ever served stale. **An invalidated entry is never served.** `getOrSet()` accepts the same `staleWhileRevalidate`, `staleIfError` and `earlyRefresh` options, and refreshes in the background.

### When Redis or the database misbehaves

```typescript
const billingCache = new TagCache({
  redis: redisClient,
  appContext: 'billing',
  operationTimeout: 200,    // a slow Redis call counts as failed instead of stalling the request
  circuitBreaker: true,     // after 5 consecutive failures, skip Redis for 5 s, then probe
  retryInvalidations: true, // failed invalidations are retried; their tags are misses until then
  replicaLagMs: 1000,       // no refills for 1 s after an invalidation, so lagging read replicas cannot re-cache old data
});

process.once('SIGTERM', () => void billingCache.flushInvalidations()); // retry anything still queued
```

With these settings an outage degrades to uncached responses, never to stale ones. Version tokens are eviction-safe: if Redis evicts or flushes them, racing writes are rejected rather than accepted.

### Metrics, tracing and finding missing invalidations

```typescript
const metrics = { hits: 0, misses: 0, staleDetected: 0 };
const reportsCache = new TagCache({
  redis: redisClient,
  appContext: 'reports',
  onEvent: (event) => {
    if (event.type === 'hit') metrics.hits++;
    if (event.type === 'miss') metrics.misses++;
    if (event.type === 'stale-detected') metrics.staleDetected++; // or a Prometheus counter / OpenTelemetry span
  },
});
const reportsMiddleware = new TagcacheMiddleware({ tagcache: reportsCache, enable: true });

app.get('/reports', reportsMiddleware.cache(['reports'], { verify: { sampleRate: 0.01 } }), (req, res) => {
  res.json({ reports: [] });
});

const impact = await reportsCache.inspectTag({ tag: 'reports' }); // what invalidating "reports" would affect
```

- **`onEvent`** receives `hit`, `miss`, `bypass`, `store`, `refresh`, `stale-detected`, `invalidate`, `circuit` and `error` events; middleware events carry a low-cardinality `route`.
- **`verify`** re-runs a sample of hits and compares the fresh response with the cached one. A difference means some `invalidate()` is missing a tag: it is logged, reported as `stale-detected`, and the entry is replaced.
- **`inspectTag()`** reports how many live entries a tag covers, some of their keys, and the index TTL.

## Production setup

A starting point for production; each option is explained in the [API reference](#api-reference):

```typescript
const apiCache = new TagCache({
  redis: redisClient,
  appContext: 'api',
  tagIndexMaintenanceMode: 'lazy', // same results as 'strict', without a write per tag on every read
  operationTimeout: 200,
  circuitBreaker: true,
  retryInvalidations: true,
  staleTtl: 300,
  ttlJitter: 0.1,
});

const apiMiddleware = new TagcacheMiddleware({
  tagcache: apiCache,
  enable: process.env.CACHE_ENABLED !== 'false',
  coalesce: { timeoutMs: 5000 },
  authGuard: 'warn',
  honorRequestCacheControl: false,
  exposeCacheKey: false,
});

// Incident kill switch: stops serving and storing, keeps invalidating, so turning it back on is safe.
apiMiddleware.setEnabled(false);
apiMiddleware.setEnabled(true);
```

## Security checklist

- **Per-user data needs `vary`.** The key ignores headers and cookies. `authGuard: 'warn'` logs routes that cache requests with an `Authorization` header and no `vary`/`key`; `authGuard: 'skip'` refuses to cache them.
- **Multi-host apps need `vary` too.** The key does not include the host; if responses differ by host, use `vary: (req) => req.hostname`.
- **Stop clients from bypassing the cache.** By default `Cache-Control: no-cache` and `Pragma: no-cache` skip the cache; in production set `honorRequestCacheControl: false` so clients cannot push every request through to your database.
- **Hide internal key names** with `exposeCacheKey: false`.
- Responses that set cookies, are `private`/`no-store`, or vary by request headers are never stored.

## Troubleshooting

**Every request is a `MISS`.** Pass `onEvent` and look at `store` events: `reason` tells you why the response was not stored.
- `not-cacheable`: the status is not 200, the body is not JSON sent with `res.json()`/`res.send()`, it sets a cookie, or it is `Cache-Control: private`/`no-store`.
- `vary`: the response varies by a request header; add `vary` (or `key`) to the route.
- `too-large`: raise `sizeGuard`.
- `rejected`: a tag was invalidated while the route ran (expected under concurrent writes), a `replicaLagMs` fence was active, or Redis failed.

**`X-Cache: BYPASS`.** The middleware is disabled, the method is not in `methods`, `skip()` returned true, `authGuard: 'skip'` applied, or the client sent `Cache-Control: no-cache` (see `honorRequestCacheControl`).

**Stale data after a change.** The mutation did not invalidate a tag the cached response has. Turn on `verify` to find the route, and invalidate the missing tag.

**`get()` returns data after its tag was invalidated.** `get()` checks only the tags you pass; pass every tag the entry was stored with.

## API reference

### `new TagCache(options)`

| Option | Default | Description |
| :--- | :--- | :--- |
| `redis` | — (required) | A connected node-redis v4, v5 or v6 client from `createClient()`. |
| `appContext` | `'tagcache'` | Namespace placed before every key. |
| `cacheTtl` | `180` | Seconds a cached value lives. |
| `tagTtl` | `240` | Minimum seconds a tag index lives; indexes always outlive their entries. |
| `deleteCacheKeys` | `true` | Default invalidation mode: `true` hard, `false` soft. |
| `tagIndexMaintenanceMode` | `'strict'` | `'lazy'` gives the same results without a Redis write per tag on every read. |
| `sizeGuard` | `2048` | Largest response body the middleware stores, in KB (UTF-8 bytes). |
| `cachePrefix` / `tagPrefix` | `'tagcache:data:'` / `'tagcache:tag:'` | Key prefixes for values and tag indexes. |
| `staleTtl` | `0` | Seconds entries stay readable after expiring, for the stale-serving options and `lookup()`. |
| `ttlJitter` | none | Spreads each TTL randomly by up to this fraction (0–1). |
| `hierarchicalTags` | off | `true` or `{ separator }`: invalidating `a` also invalidates `a:b` and `a:b:c`. |
| `operationTimeout` | none | Milliseconds after which a Redis operation counts as failed. |
| `circuitBreaker` | off | `true` or `{ failureThreshold, cooldownMs }` (defaults 5 and 5000). |
| `retryInvalidations` | off | `true` or `{ maxDelayMs, maxQueued }` (defaults 30000 and 10000). Beyond `maxQueued`, the namespace is a miss until Redis is back and it has been purged. |
| `replicaLagMs` | none | After an invalidation, refuse writes for its tags for this long. |
| `backgroundPurge` | `false` | Hard invalidation returns before deleting the values. |
| `onEvent` | none | `(event) => void`, called for every cache event. |
| `logger` | `console` | `{ error(message, error), warn?(message) }`. |

Invalid numbers (zero, negative, fractional TTLs) fall back to the defaults. **Methods never throw** for Redis or input errors: they are reported to `logger.error` and the method returns `null` or `false`.

| Method | Returns | Description |
| :--- | :--- | :--- |
| `get({ key, tags, appContext? })` | `string \| null` | The value if it exists, has not expired, and still belongs to every tag in `tags`. |
| `set({ key, value, tags, cacheTtl?, tagTtl?, appContext?, ifTagVersions? })` | `boolean` | Stores `value` atomically under `key` and `tags`. `false` on error, stale `ifTagVersions`, or an active fence. |
| `getOrSet({ key, tags, load, cacheTtl?, tagTtl?, appContext?, staleWhileRevalidate?, staleIfError?, earlyRefresh?, refreshLeaseMs? })` | `string` | The cached value, or `load()`'s result (which must be a string), cached race-safely. Rejects only if `load()` fails and no stale value may be used. |
| `invalidate({ tags, deleteCacheKeys?, appContext? })` | `boolean` | Invalidates every entry under any of `tags`. |
| `lookup({ key, tags, appContext? })` | `{ value, expiresAt, stale } \| null` | Like `get()`, but also returns entries expired within `staleTtl`. |
| `isMember({ key, tags, appContext? })` | `boolean` | Whether `key` is currently indexed under every tag in `tags`. |
| `delete({ key, appContext? })` | `boolean` | Deletes one cached value. |
| `getTagVersions({ tags, appContext? })` | `TagVersions \| null` | Snapshot to pass to `set({ ifTagVersions })` for race-safe writes in custom flows. |
| `inspectTag({ tag, limit?, appContext? })` | `{ entries, keys, ttl } \| null` | What invalidating `tag` would affect right now. |
| `acquireLease({ key, ttlMs?, appContext? })` / `releaseLease({ key, token, appContext? })` | `string \| null` / `boolean` | A short lock shared by every instance. |
| `flushInvalidations()` / `pendingInvalidations` | `boolean` / `number` | Retry queued invalidations now / how many are pending. |

### `new TagcacheMiddleware(options)`

| Option | Default | Description |
| :--- | :--- | :--- |
| `tagcache` | — (required) | The `TagCache` to use. |
| `enable` | — (required) | `false` turns `cache()` into a pass-through and `invalidate()` into a no-op. |
| `coalesce` | `false` | Default for `cache()`'s `coalesce`. |
| `authGuard` | `'off'` | Default for `cache()`'s `authGuard`. |
| `honorRequestCacheControl` | `true` | Default for `cache()`'s `honorRequestCacheControl`. |
| `refreshLeaseMs` | `10000` | Default for `cache()`'s `refreshLeaseMs`. |
| `exposeCacheKey` | `true` | Send `X-Cache-Key` on hits. |

| Method | Description |
| :--- | :--- |
| `cache(tags, options?)` | Serves cached responses and stores new ones. |
| `invalidate(tags, { deleteCacheKeys?, appContext? }?)` | Invalidates `tags` before a 200–304 response is sent; other responses invalidate nothing. |
| `setEnabled(enabled)` / `enabled` | Turns caching on or off at runtime; invalidation keeps running while it is off. |

`tags` is an array of strings or `(req) => string` functions; tags that resolve to empty strings are ignored, and a function returning a Promise is an error.

**`cache()` options:**

| Option | Description |
| :--- | :--- |
| `vary(req)` | Extra input for the key, such as the user ID or the host. |
| `key(req)` | Your own key instead of path, params, query and body (hashed with the method). |
| `ignoreQuery` | Query parameters left out of the key; `'utm_*'` matches a prefix. |
| `ttl` | Seconds entries from this route live. |
| `methods` | Only these methods use the cache, e.g. `['GET', 'HEAD']`. |
| `skip(req)` | Return `true` to bypass the cache for a request. |
| `coalesce` | `true` or `{ timeoutMs }`: identical concurrent misses share one route run. |
| `staleWhileRevalidate` | Seconds past expiry an entry is served while one request refreshes it. |
| `staleIfError` | Seconds past expiry an entry is served instead of a 5xx. |
| `earlyRefresh` | `true` or `{ beta }`: refresh popular entries before they expire. |
| `refreshLeaseMs` | How long a refresh holds its lease; keep it above the route's slowest response. |
| `verify` | `{ sampleRate, compare? }`: re-run a sample of hits to detect stale entries. |
| `authGuard` | `'off'`, `'warn'` or `'skip'` for requests with an `Authorization` header and no `vary`/`key`. |
| `honorRequestCacheControl` | Whether client `Cache-Control: no-cache`/`Pragma: no-cache` skips the cache. |

### Entry points

`express-tag-cache` exports everything; `express-tag-cache/core` exports only `TagCache`, and `express-tag-cache/middleware` only `TagcacheMiddleware`.

## Upgrading

**To 2.5.** Two fixes change what gets cached: only `200` responses are stored (a cached `202 Accepted` used to outlive its job), and responses with a `Vary` on request headers are not stored unless the route sets `vary` or `key` (Express's `res.format()` adds `Vary: Accept`). Tag functions that return a Promise and `getOrSet()` loaders that resolve to a non-string now fail loudly instead of caching wrong data.

**From v1.** The second argument of the middleware `invalidate()` changed from an `appContext` string to an options object in v2.0.0:

```typescript
// v1: invalidate(['users'], 'user-service')
app.delete('/users/:id', cacheMiddleware.invalidate(['users'], { appContext: 'user-service' }), (req, res) => {
  res.json({ deleted: true });
});
```

## License

MIT
