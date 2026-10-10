# express-tag-cache

Tag-based Redis caching middleware for Express. Cache JSON responses, then invalidate every response that shares a tag with one call.

[![npm downloads](https://img.shields.io/npm/dm/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![npm version](https://img.shields.io/npm/v/express-tag-cache?style=for-the-badge)](https://www.npmjs.com/package/express-tag-cache)
[![license](https://img.shields.io/github/license/dsbalico/express-tag-cache?style=for-the-badge)](https://github.com/dsbalico/express-tag-cache/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Supported-blue?style=for-the-badge)](https://www.typescriptlang.org/)

## Features

- **Tag-based invalidation**: invalidate every entry that shares a tag, without tracking keys yourself.
- **Consistent after writes**: invalidation finishes before the mutation's response is sent, and responses computed from data that was invalidated mid-request are never cached.
- **Stampede protection**: concurrent misses for the same entry can share one route run or one `load()` call.
- **Express middleware** plus a programmatic API for anything else.
- **Multi-service**: namespaces (`appContext`) let several services share one Redis and read or invalidate each other's caches.
- **Typed**, zero runtime dependencies.

## Requirements

- Node.js 18+. The package is ESM-only; from CommonJS use `require()` on Node 20.19+ / 22.12+, or `await import()`.
- Express 4 or 5, and the [`redis`](https://www.npmjs.com/package/redis) client v4 or v5 (peer dependencies).
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

**Bypass.** Requests skip the cache (and are not stored) when `enable` is `false` or the request sends `Cache-Control: no-cache`, `Cache-Control: no-store` or `Pragma: no-cache`.

**Response headers.** `X-Cache: HIT` (with `X-Cache-Key`, the Redis key), `X-Cache: MISS`, or `X-Cache: BYPASS`.

**Keys and tags** are trimmed and lowercased, so `User:1` and `user:1` are the same.

## Invalidation

- **Hard** (`deleteCacheKeys: true`, the default): deletes the tag indexes and every cached value under them.
- **Soft** (`deleteCacheKeys: false`): deletes only the tag indexes, in a single round trip. The values become unreachable and expire on their own TTL. Prefer soft for tags with many entries.

### Race-safe writes outside the middleware

A value loaded before an invalidation and written after it would be stale. The middleware and `getOrSet()` guard against this automatically. For custom flows, snapshot the tags before loading; the write is skipped if any of them is invalidated in between:

```typescript
const versions = await tagcache.getTagVersions({ tags: ['users'] });
const users = [{ id: 1 }]; // load from the database here

if (versions) {
  const written = await tagcache.set({ key: 'users:all', value: JSON.stringify(users), tags: ['users'], ifTagVersions: versions });
  // written === false: 'users' was invalidated while loading; nothing was cached.
}
```

## Production notes

- **Set `operationTimeout`** (for example `200`). Without it, a slow Redis holds up cached requests and mutation responses for as long as Redis takes. With it, slow reads become misses and slow invalidations are abandoned; an abandoned invalidation may still complete in Redis, and if it does not, entries can stay until their TTL.
- **Prefer `tagIndexMaintenanceMode: 'lazy'`.** It gives the same results as `'strict'` without a Redis write per tag on every read. `'strict'` remains the default for compatibility.
- **Turn on `coalesce`** for routes that are hit often or are expensive to compute.
- **Use soft invalidation for broad tags** such as `products`: hard invalidation deletes every entry under the tag at once.
- **Limits:** Redis Cluster is not supported. Only JSON responses are cached, and hits are replayed with status 200 without the original headers. Entry expiry is computed with the app server's clock, so clock skew between servers shifts expiry by that skew; invalidation does not depend on clocks.

## API Reference

### `new TagCache(options)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `redis` | node-redis v4/v5 client | — (required) | A connected client from `createClient()`. |
| `appContext` | `string` | `'tagcache'` | Namespace placed before every key. |
| `cachePrefix` | `string` | `'tagcache:data:'` | Prefix for cached value keys. |
| `tagPrefix` | `string` | `'tagcache:tag:'` | Prefix for tag index keys. |
| `cacheTtl` | `number` | `180` | TTL of cached values, in whole seconds. |
| `tagTtl` | `number` | `240` | Minimum TTL of tag indexes, in whole seconds. Indexes always live at least as long as their entries, and a write never shortens them. |
| `sizeGuard` | `number` | `2048` | Largest response body the middleware caches, in KB (UTF-8 bytes). |
| `deleteCacheKeys` | `boolean` | `true` | Default invalidation mode: `true` hard, `false` soft. |
| `tagIndexMaintenanceMode` | `'strict' \| 'lazy'` | `'strict'` | Both modes treat expired entries as misses and prune them on writes. `'strict'` also prunes on every read (one extra write per tag); `'lazy'` keeps reads read-only. |
| `logger` | `{ error(message, error) }` | `console` | Receives errors the library catches. |
| `operationTimeout` | `number` | none | Milliseconds after which a Redis operation counts as failed. |

Invalid numbers (zero, negative, fractional TTLs) fall back to the defaults. The resolved values are on `tagcache.cacheOptions`.

**Methods never throw.** Redis or input errors are sent to `logger.error`, and the method returns `null` or `false`.

| Method | Returns | Description |
| :--- | :--- | :--- |
| `get({ key, tags, appContext? })` | `Promise<string \| null>` | The value, if it exists, has not expired, and still belongs to every tag in `tags`. |
| `set({ key, value, tags, cacheTtl?, tagTtl?, appContext?, ifTagVersions? })` | `Promise<boolean>` | Stores `value` under `key` and indexes it under `tags`, atomically. `false` on error, or when `ifTagVersions` is stale. |
| `invalidate({ tags, deleteCacheKeys?, appContext? })` | `Promise<boolean>` | Invalidates every entry under any of `tags`. |
| `isMember({ key, tags, appContext? })` | `Promise<boolean>` | Whether `key` is currently indexed under every tag in `tags`. |
| `delete({ key, appContext? })` | `Promise<boolean>` | Deletes one cached value. |
| `getOrSet({ key, tags, load, cacheTtl?, tagTtl?, appContext? })` | `Promise<string>` | The cached value, or the result of `load()`, cached race-safely. Concurrent calls for the same key share one `load()`. Rejects only if `load()` does. |
| `getTagVersions({ tags, appContext? })` | `Promise<TagVersions \| null>` | Snapshot for race-safe `set()` calls. |

### `new TagcacheMiddleware({ tagcache, enable, coalesce? })`

`coalesce` sets the default for every `cache()` route (default `false`).

| Method | Description |
| :--- | :--- |
| `cache(tags, { vary?, ignoreQuery?, coalesce? }?)` | Serves cached responses and caches new ones, as described in [How the middleware caches](#how-the-middleware-caches). |
| `invalidate(tags, { deleteCacheKeys?, appContext? }?)` | Invalidates `tags` before a 200–304 response is sent. Options default to the TagCache's settings. |

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
