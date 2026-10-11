# express-tag-cache

Tag-based Redis caching middleware for Express. Cache JSON responses, then invalidate every response that shares a tag with one call.

[![npm downloads](https://img.shields.io/npm/dm/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![npm version](https://img.shields.io/npm/v/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![license](https://img.shields.io/github/license/dsbalico/express-tag-cache?style=for-the-badge)](https://github.com/dsbalico/express-tag-cache/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Supported-blue?style=for-the-badge)](https://www.typescriptlang.org/)

## Features

- **Tag-based invalidation**, including hierarchical tags (`tenant:42` covers `tenant:42:*`).
- **No stale reads after writes**: invalidation finishes before the mutation's response is sent; values computed from data invalidated mid-request, read from a lagging replica, or written after a lost version key are never cached.
- **High-traffic ready**: request coalescing, stale-while-revalidate with a single refresher across instances, probabilistic early refresh, TTL jitter.
- **Keeps working when things break**: timeouts, a circuit breaker, retried invalidations, stale-if-error.
- **Observable**: an event hook for metrics and tracing, invalidation previews, and sampled detection of stale entries.
- **Express middleware** plus a programmatic API (`getOrSet()` and friends), multi-service namespaces, TypeScript types, zero runtime dependencies.

## Requirements

- Node.js 18+. The package is ESM-only; from CommonJS use `require()` on Node 20.19+ / 22.12+, or `await import()`.
- Express 4 or 5, and the [`redis`](https://www.npmjs.com/package/redis) client v4, v5 or v6 (peer dependencies).
- A standalone Redis server, 4.0 or later (tested with 7.x). Redis Cluster is not supported.

## Installation

```bash
npm install express-tag-cache redis express
```

## Quick Start

### 1. Create the cache and middleware

```typescript
import { createClient } from 'redis';
import { TagCache, TagcacheMiddleware } from 'express-tag-cache';

const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

const tagcache = new TagCache({
  redis: redisClient,
  appContext: 'my-app', // namespace for every key this instance writes
  cacheTtl: 180,        // seconds a cached response lives
  operationTimeout: 200, // ms; a slow Redis call counts as a miss instead of stalling the request
});

const cacheMiddleware = new TagcacheMiddleware({
  tagcache,
  enable: true, // false turns both middlewares into pass-throughs
});
```

### 2. Cache routes

Tags are strings, or functions that derive a tag from the request:

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/products', cacheMiddleware.cache(['products']), (req, res) => {
  res.json({ products: [] });
});

app.get(
  '/api/products/:id',
  cacheMiddleware.cache(['products', (req) => `product:${req.params.id}`]),
  (req, res) => {
    res.json({ id: req.params.id, name: 'Product' });
  },
);
```

### 3. Invalidate on writes

```typescript
app.post('/api/products', cacheMiddleware.invalidate(['products']), (req, res) => {
  res.status(201).json({ created: true });
});

app.put(
  '/api/products/:id',
  cacheMiddleware.invalidate(['products', (req) => `product:${req.params.id}`]),
  (req, res) => {
    res.json({ updated: true });
  },
);
```

When the handler responds with a status from 200 to 304, the tags are invalidated *before* the response is sent, so the client's next read is fresh.

### 4. Use the cache directly

```typescript
const user = { id: 123, name: 'Ada' };

await tagcache.set({
  key: 'user:123',
  value: JSON.stringify(user),
  tags: ['users', 'user:123'],
  cacheTtl: 3600,
});

const cachedUser = await tagcache.get({ key: 'user:123', tags: ['users', 'user:123'] }); // string | null

await tagcache.invalidate({ tags: ['user:123'] });

// Or read-through: load() runs only on a miss, once for all concurrent callers.
const products = await tagcache.getOrSet({
  key: 'products:all',
  tags: ['products'],
  load: async () => JSON.stringify([{ id: 1 }]),
});
```

`get()` checks only the tags you pass, so pass every tag the entry was stored with.

### 5. Share Redis between services

Every method accepts an `appContext` to act on another service's namespace:

```typescript
const orderCache = new TagCache({ redis: redisClient, appContext: 'order-service' });

// Read and invalidate user-service's cache from order-service.
const userFromOtherService = await orderCache.get({ key: 'user:123', tags: ['users'], appContext: 'user-service' });
await orderCache.invalidate({ tags: ['users'], appContext: 'user-service' });

// The same from middleware.
const orderMiddleware = new TagcacheMiddleware({ tagcache: orderCache, enable: true });
app.post('/api/orders', orderMiddleware.invalidate(['users'], { appContext: 'user-service' }), (req, res) => {
  res.status(201).json({ ordered: true });
});
```

## How the middleware caches

**What is cached.** A response sent with `res.json()` or `res.send()` is stored if all of the following hold:
- its status is 2xx and its `Content-Type` is `application/json`;
- it sets no cookies and has no `Cache-Control: private` or `no-store`;
- its body is at most `sizeGuard` KB;
- none of its tags were invalidated while the handler ran.

The stored body is exactly what Express sent. Cache hits replay it with status 200 and `Content-Type: application/json`; other response headers are not stored.

**The cache key** is a SHA-256 of the method, the full path (router mount path included, trailing slash ignored), `req.params`, `req.query` minus any `ignoreQuery` parameters, the body for POST/PUT/PATCH, and the optional `vary` value.

**Coalescing.** With `coalesce: true`, identical requests that miss while the route is already running for the same key wait for that run and are served its response (`X-Cache: HIT`) instead of each running the route. They wait only for a response that ends up cached; if it doesn't, they run the route themselves. Enable it on popular routes:

```typescript
app.get(
  '/api/catalog',
  cacheMiddleware.cache(['products'], { coalesce: true, ignoreQuery: ['utm_*', 'fbclid'] }),
  (req, res) => {
    res.json({ catalog: [] });
  },
);
```

> [!WARNING]
> Headers and cookies are **not** part of the key. A route whose response depends on who is asking, such as `GET /me`, would serve one user's data to another. Add the user to the key with `vary`:
>
> ```typescript
> app.get('/api/me', cacheMiddleware.cache(['users'], { vary: (req) => req.get('authorization') }), (req, res) => {
>   res.json({ me: true });
> });
> ```

**Bypass.** Requests skip the cache (and are not stored) when caching is disabled, the method is not in `methods`, `skip(req)` returns `true`, `authGuard: 'skip'` applies, or the request sends `Cache-Control: no-cache`, `Cache-Control: no-store` or `Pragma: no-cache`.

**Response headers.** `X-Cache: HIT` (with `X-Cache-Key`, the Redis key), `MISS` (the route ran), `STALE` (an expired entry was served, see [Serving stale data safely](#serving-stale-data-safely)) or `BYPASS`.

**Keys and tags** are trimmed and lowercased, so `User:1` and `user:1` are the same.

## Invalidation

- **Hard** (`deleteCacheKeys: true`, the default): deletes the tag indexes and every cached value under them. With `backgroundPurge: true`, the call returns once the tags are invalidated and the values are deleted afterwards in batches.
- **Soft** (`deleteCacheKeys: false`): deletes only the tag indexes, in a single round trip. The values become unreachable and expire on their own TTL. Prefer soft for tags with many entries.

**Hierarchical tags.** With `hierarchicalTags: true`, `tenant:42:users:7` also belongs to `tenant:42:users`, `tenant:42` and `tenant`, so one call invalidates a whole subtree:

```typescript
const tenantCache = new TagCache({ redis: redisClient, appContext: 'tenants', hierarchicalTags: true });

await tenantCache.set({ key: 'tenant:42:user:7', value: '{"id":7}', tags: ['tenant:42:users:7'] });
await tenantCache.invalidate({ tags: ['tenant:42'] }); // invalidates every entry of tenant 42
```

### Race-safe writes outside the middleware

A value loaded before an invalidation and written after it would be stale. The middleware and `getOrSet()` guard against this automatically. For custom flows, snapshot the tags before loading; the write is skipped if any of them is invalidated in between, or if the snapshot's version keys have since been evicted:

```typescript
const versions = await tagcache.getTagVersions({ tags: ['users'] });
const users = [{ id: 1 }]; // load from the database here

if (versions) {
  const written = await tagcache.set({ key: 'users:all', value: JSON.stringify(users), tags: ['users'], ifTagVersions: versions });
  // written === false: 'users' was invalidated while loading; nothing was cached.
}
```

## Serving stale data safely

With `staleTtl`, entries stay readable for that many seconds after they expire. Routes and `getOrSet()` calls opt in to using them:

- **`staleWhileRevalidate`**: an expired entry is served at once (`X-Cache: STALE`) while a single request, across all instances, refreshes it.
- **`staleIfError`**: an expired entry is served instead of a 5xx from the route (or a rejected `load()`).
- **`earlyRefresh`**: popular entries are refreshed shortly *before* they expire, by one request, so they never expire for everyone at once.

Only entries that expired by time are served stale. **An invalidated entry is never served.**

```typescript
const catalogCache = new TagCache({ redis: redisClient, appContext: 'catalog', staleTtl: 300 });
const catalogMiddleware = new TagcacheMiddleware({ tagcache: catalogCache, enable: true });

app.get(
  '/api/featured',
  catalogMiddleware.cache(['products'], { staleWhileRevalidate: 60, staleIfError: 300, earlyRefresh: true }),
  (req, res) => {
    res.json({ featured: [] });
  },
);

const featured = await catalogCache.getOrSet({
  key: 'featured',
  tags: ['products'],
  load: async () => JSON.stringify({ featured: [] }),
  staleWhileRevalidate: 60,
  staleIfError: 300,
});
```

## When Redis or the database misbehaves

```typescript
const ordersCache = new TagCache({
  redis: redisClient,
  appContext: 'orders',
  operationTimeout: 200,       // slow Redis calls count as failures instead of stalling requests
  circuitBreaker: true,        // after 5 consecutive failures, skip Redis for 5 s, then probe
  retryInvalidations: true,    // failed invalidations are retried; their tags are misses meanwhile
  replicaLagMs: 1000,          // no refills for 1 s after an invalidation, so lagging replicas can't re-cache old data
});

process.once('SIGTERM', () => {
  void ordersCache.flushInvalidations(); // retry anything still queued before exiting
});
```

- **`operationTimeout`**: slow reads become misses and slow invalidations are abandoned (and retried with `retryInvalidations`).
- **`circuitBreaker`**: while open, every operation answers with its fallback immediately; requests are served by your routes, uncached.
- **`retryInvalidations`**: a failed invalidation is kept in memory and retried with backoff. Until it succeeds, this instance treats its tags as misses. Queued invalidations do not survive a crash; other instances only see them once they are applied.
- **`replicaLagMs`**: set it to your replicas' worst-case lag if routes read from replicas.
- **Version keys are eviction-safe**: if Redis evicts or flushes a tag's version key, writes based on an older snapshot are rejected rather than accepted.

## Observability and operations

```typescript
const counters: Record<string, number> = {};
const reportsCache = new TagCache({
  redis: redisClient,
  appContext: 'reports',
  onEvent: (event) => {
    const name = event.type === 'hit' ? `hit.${event.source}` : event.type;
    counters[name] = (counters[name] ?? 0) + 1; // or a Prometheus counter / OpenTelemetry span
  },
});
const reportsMiddleware = new TagcacheMiddleware({ tagcache: reportsCache, enable: true, authGuard: 'warn' });

app.get('/api/reports', reportsMiddleware.cache(['reports'], { verify: { sampleRate: 0.001 } }), (req, res) => {
  res.json({ reports: [] });
});

const preview = await reportsCache.inspectTag({ tag: 'reports' }); // { entries, keys, ttl }

reportsMiddleware.setEnabled(false); // kill switch: stop serving and storing, keep invalidating
reportsMiddleware.setEnabled(true);
```

- **`onEvent`** receives `hit` (`source`: `redis`, `coalesced` or `stale`), `miss`, `bypass`, `store` (with `stored`, `reason`, `bytes`), `refresh`, `stale-detected`, `invalidate` (with `durationMs`), `circuit` and `error` events. Middleware events carry the `route`.
- **`verify`** re-runs a sample of cache hits and compares the fresh response with the cached one. A difference means some `invalidate()` is missing a tag; it is logged, reported as `stale-detected` and the entry is replaced.
- **`authGuard`** catches the most common caching bug, per-user responses without `vary`: `'warn'` logs once per route, `'skip'` refuses to cache requests with an `Authorization` header unless the route sets `vary` or `key`.
- **`setEnabled(false)`** keeps invalidating while caching is off, so turning it back on never serves data that changed meanwhile.

## Production notes

- **Set `operationTimeout`**, and consider `circuitBreaker` and `retryInvalidations`.
- **Prefer `tagIndexMaintenanceMode: 'lazy'`.** It gives the same results as `'strict'` without a Redis write per tag on every read. `'strict'` remains the default for compatibility.
- **Turn on `coalesce`** (and `earlyRefresh` or `staleWhileRevalidate`) for routes that are hit often or are expensive to compute, and set `ttlJitter` (e.g. `0.1`) so entries written together do not expire together.
- **Use soft invalidation or `backgroundPurge` for broad tags** such as `products`.
- **Rolling upgrades:** instances on older versions can share a namespace with newer ones. `hierarchicalTags` and `replicaLagMs` only take full effect once every instance writing to the namespace uses them.
- **Limits:** Redis Cluster is not supported. Only JSON responses are cached, and hits are replayed with status 200 without the original headers. Entry expiry is computed with the app server's clock, so clock skew between servers shifts expiry by that skew; invalidation does not depend on clocks.

## API Reference

### `new TagCache(options)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `redis` | node-redis v4, v5 or v6 client | — (required) | A connected client from `createClient()`. |
| `appContext` | `string` | `'tagcache'` | Namespace placed before every key. |
| `cachePrefix` | `string` | `'tagcache:data:'` | Prefix for cached value keys. |
| `tagPrefix` | `string` | `'tagcache:tag:'` | Prefix for tag index keys. |
| `cacheTtl` | `number` | `180` | TTL of cached values, in whole seconds. |
| `tagTtl` | `number` | `240` | Minimum TTL of tag indexes, in whole seconds. Indexes always live at least as long as their entries, and a write never shortens them. |
| `sizeGuard` | `number` | `2048` | Largest response body the middleware caches, in KB (UTF-8 bytes). |
| `deleteCacheKeys` | `boolean` | `true` | Default invalidation mode: `true` hard, `false` soft. |
| `tagIndexMaintenanceMode` | `'strict' \| 'lazy'` | `'strict'` | Both modes treat expired entries as misses and prune them on writes. `'strict'` also prunes on every read (one extra write per tag); `'lazy'` keeps reads read-only. |
| `logger` | `{ error(message, error), warn?(message) }` | `console` | Receives errors and warnings the library catches. |
| `operationTimeout` | `number` | none | Milliseconds after which a Redis operation counts as failed. |
| `staleTtl` | `number` | `0` | Seconds entries stay readable after expiring, for `lookup()` and the stale-serving options. |
| `ttlJitter` | `number` | none | Spreads each TTL randomly by up to this fraction (0–1). |
| `hierarchicalTags` | `boolean \| { separator }` | off | Treat tags as `:`-separated paths; invalidating an ancestor invalidates descendants. |
| `replicaLagMs` | `number` | none | After an invalidation, refuse writes for its tags for this long. |
| `circuitBreaker` | `boolean \| { failureThreshold?, cooldownMs? }` | off | Skip Redis after consecutive failures (defaults 5 and 5000 ms). |
| `retryInvalidations` | `boolean \| { maxDelayMs? }` | off | Retry failed invalidations; treat their tags as misses meanwhile. |
| `backgroundPurge` | `boolean` | `false` | Return from hard invalidation before deleting the values. |
| `onEvent` | `(event) => void` | none | Receives cache events for metrics and tracing. |

Invalid numbers (zero, negative, fractional TTLs) fall back to the defaults. The resolved values are on `tagcache.cacheOptions`.

**Methods never throw.** Redis or input errors are sent to `logger.error`, and the method returns `null` or `false`.

| Method | Returns | Description |
| :--- | :--- | :--- |
| `get({ key, tags, appContext? })` | `Promise<string \| null>` | The value, if it exists, has not expired, and still belongs to every tag in `tags`. |
| `set({ key, value, tags, cacheTtl?, tagTtl?, appContext?, ifTagVersions? })` | `Promise<boolean>` | Stores `value` under `key` and indexes it under `tags`, atomically. `false` on error, or when `ifTagVersions` is stale. |
| `invalidate({ tags, deleteCacheKeys?, appContext? })` | `Promise<boolean>` | Invalidates every entry under any of `tags`. |
| `isMember({ key, tags, appContext? })` | `Promise<boolean>` | Whether `key` is currently indexed under every tag in `tags`. |
| `delete({ key, appContext? })` | `Promise<boolean>` | Deletes one cached value. |
| `getOrSet({ key, tags, load, cacheTtl?, tagTtl?, appContext?, staleWhileRevalidate?, staleIfError? })` | `Promise<string>` | The cached value, or the result of `load()`, cached race-safely. Concurrent calls for the same key share one `load()`. Rejects only if `load()` does and no stale value may be used. |
| `lookup({ key, tags, appContext? })` | `Promise<{ value, expiresAt, stale } \| null>` | Like `get()`, but also returns entries expired within `staleTtl`. |
| `getTagVersions({ tags, appContext? })` | `Promise<TagVersions \| null>` | Snapshot for race-safe `set()` calls. |
| `acquireLease({ key, ttlMs?, appContext? })` / `releaseLease({ key, token, appContext? })` | `Promise<string \| null>` / `Promise<boolean>` | A short lock shared by all instances, e.g. to let one of them refresh an entry. |
| `inspectTag({ tag, limit?, appContext? })` | `Promise<{ entries, keys, ttl } \| null>` | What invalidating `tag` would affect right now. |
| `flushInvalidations()` / `pendingInvalidations` | `Promise<boolean>` / `number` | Retry queued invalidations now / how many are queued (`retryInvalidations`). |

### `new TagcacheMiddleware({ tagcache, enable, coalesce?, authGuard? })`

`coalesce` and `authGuard` set the defaults for every `cache()` route.

| Method | Description |
| :--- | :--- |
| `cache(tags, options?)` | Serves cached responses and caches new ones, as described in [How the middleware caches](#how-the-middleware-caches). |
| `invalidate(tags, { deleteCacheKeys?, appContext? }?)` | Invalidates `tags` before a 200–304 response is sent. Options default to the TagCache's settings. |
| `setEnabled(enabled)` / `enabled` | Turns caching on or off at runtime; invalidation keeps running while it is off. |

`cache()` options:

| Option | Description |
| :--- | :--- |
| `vary(req)` | Extra input for the cache key, such as the user. |
| `ignoreQuery` | Query parameters left out of the key (`'utm_*'` matches a prefix). |
| `key(req)` | Your own cache key instead of path, params, query and body. |
| `ttl` | Seconds entries from this route live. |
| `methods` | Only these methods use the cache. |
| `skip(req)` | Return `true` to bypass the cache for a request. |
| `coalesce` | Concurrent identical misses share one route run. |
| `staleWhileRevalidate` | Seconds past expiry an entry is served while one request refreshes it. |
| `staleIfError` | Seconds past expiry an entry is served instead of a 5xx. |
| `earlyRefresh` | `true` or `{ beta }`: refresh popular entries before they expire. |
| `verify` | `{ sampleRate, compare? }`: re-run sampled hits to detect stale entries. |
| `authGuard` | `'off'`, `'warn'` or `'skip'` for requests with an `Authorization` header and no `vary`/`key`. |

`tags` is an array of `string | (req: Request) => string`. Tags that resolve to an empty string are ignored; if none remain, the middleware does nothing.

### Entry points

`express-tag-cache` exports everything. `express-tag-cache/core` exports only `TagCache`, and `express-tag-cache/middleware` exports only `TagcacheMiddleware`.

## Migrating from v1

The second argument of the middleware `invalidate()` changed from an `appContext` string to an options object in v2.0.0:

```typescript
// v1: invalidate(['users'], 'user-service')
app.delete('/api/users/:id', cacheMiddleware.invalidate(['users'], { appContext: 'user-service' }), (req, res) => {
  res.json({ deleted: true });
});
```

## License

MIT
