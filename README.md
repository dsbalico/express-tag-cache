# express-tag-cache

A high-performance, tag-based Redis caching middleware for Express applications. Efficiently cache responses and invalidate them by tags.

## Features

- **Tag-based Invalidation**: Invalidate multiple cache entries at once by targeting shared tags.
- **Redis-backed**: Fast, persistent caching using Redis.
- **Express Middleware**: Easy integration into any Express project.
- **TypeScript Support**: Fully typed for a better developer experience.
- **Context Awareness**: Support for multi-tenant applications using app context prefixes.

## Installation

```bash
npm install express-tag-cache redis express
```

*Note: `redis` and `express` are peer dependencies.*

## Quick Start

### 1. Initialize TagCache

```typescript
import { createClient } from 'redis';
import { TagCache, TagcacheMiddleware } from 'express-tag-cache';

const redisClient = createClient();
await redisClient.connect();

const tagcache = new TagCache({
  redis: redisClient,
  tagPrefix: 'tag:',
  cachePrefix: 'cache:',
  tagTtl: 240,       // Default TTL for tag sets in seconds
  cacheTtl: 180,     // Default TTL for cache entries in seconds
  appContext: 'my-app',
  sizeGuard: 2048    // Maximum allowed cache entry size in KB (e.g., 2MB)
});

const cacheMiddleware = new TagcacheMiddleware({
  tagcache,
  enable: true       // Set to false to globally bypass cache/invalidation middleware
});
```

### 2. Use Middleware to Cache Routes

You can cache routes using static tags, dynamic tags (resolved using functions that take the Express `Request` object), or a combination of both:

```typescript
import express from 'express';

const app = express();

// Cache list of products (static tags)
app.get('/api/products', 
  cacheMiddleware.cache(['products', 'list']), 
  async (req, res) => {
    // Data fetching logic...
    res.json({ products: [] });
  }
);

// Cache a single product dynamically based on request params
app.get('/api/products/:id',
  cacheMiddleware.cache([
    'products',
    (req) => `products:${req.params.id}`
  ]),
  async (req, res) => {
    // Data fetching logic...
    res.json({ id: req.params.id, name: 'Product Details' });
  }
);
```

### 3. Invalidate Cache via Middleware

Invalidate caches automatically when mutating data:

```typescript
// Invalidate list cache on creation
app.post('/api/products', 
  cacheMiddleware.invalidate(['products']), 
  async (req, res) => {
    // Product creation logic...
    res.json({ success: true });
  }
);

// Invalidate both list and specific item caches on update
app.put('/api/products/:id',
  cacheMiddleware.invalidate([
    'products',
    (req) => `products:${req.params.id}`
  ]),
  async (req, res) => {
    // Product update logic...
    res.json({ success: true });
  }
);
```

### 4. Direct Programmatic Usage

```typescript
// Set cache manually
await tagcache.set({
  key: 'user:123',
  value: JSON.stringify(userData),
  tags: ['users', 'user:123'],
  cacheTtl: 3600,    // Override default cacheTtl in seconds
  tagTtl: 7200       // Override default tagTtl in seconds
});

// Get cache manually
const cachedData = await tagcache.get({
  key: 'user:123',
  tags: ['users']    // Will return null if any associated tag was invalidated
});

// Invalidate tags manually
await tagcache.invalidate({
  tags: ['user:123'],
  deleteCacheKeys: true // Set to false for soft invalidation (tag set deletion only)
});
```

## API Reference

### `TagCache`

The core caching class that manages Redis interactions, tag association, and invalidations.

#### `constructor(options: TagCacheOptions)`

Initializes a new `TagCache` instance.

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `redis` | `RedisClientType` | **Yes** | — | An active, connected Redis client instance (compatible with the `redis` npm package). |
| `tagPrefix` | `string` | No | `'tagcache:tag:'` | Prefix prepended to all tag set keys in Redis. |
| `cachePrefix` | `string` | No | `'tagcache:data:'` | Prefix prepended to all cache value keys in Redis. |
| `tagTtl` | `number` | No | `240` | Default time-to-live (TTL) in seconds for tag set keys. Must be `>= 0`. |
| `cacheTtl` | `number` | No | `180` | Default time-to-live (TTL) in seconds for cached value keys. Must be `>= 0`. |
| `appContext` | `string` | No | `'tagcache'` | A namespace prefix applied before all keys, providing isolation for multi-tenant applications. |
| `sizeGuard` | `number` | No | `2048` | Maximum cache entry size in KB. Cache attempts exceeding this limit are skipped to prevent Redis performance degradation. Must be `> 0`. |

---

#### `get(options: CacheFetchOptions)`

Fetches a cached value by its key. The cache entry is only returned if it is still valid and has not been invalidated by any of its associated tags.

```typescript
const value = await tagcache.get({
  key: 'user:profile:123',
  tags: ['users', 'user:123']
});
```

**Parameters (`CacheFetchOptions`):**
- `key` (`string`): The original, un-prefixed cache key.
- `tags` (`string[]`): An array of tags associated with this cache key. The method verifies if the cache key is still present in the Redis set for *every* tag. If the key has been removed from any tag set (invalidated), this method returns `null`.

**Returns:** `Promise<string | null>` — The cached string value if valid, or `null` if expired, invalidated, or not found.

---

#### `set(options: CacheStoreOptions)`

Stores a value in the cache, associates it with a list of tags, and configures the TTLs.

```typescript
await tagcache.set({
  key: 'user:profile:123',
  value: JSON.stringify(userProfile),
  tags: ['users', 'user:123'],
  cacheTtl: 300,
  tagTtl: 600
});
```

**Parameters (`CacheStoreOptions`):**
- `key` (`string`): The original, un-prefixed cache key.
- `value` (`string`): The string value to cache (usually serialized JSON).
- `tags` (`string[]`): An array of tags to associate with this cached item.
- `cacheTtl` (`number`, optional): TTL in seconds for this cache entry. Falls back to the instance's default `cacheTtl` if not specified.
- `tagTtl` (`number`, optional): TTL in seconds for the tag set keys. Falls back to the instance's default `tagTtl` if not specified.

**Returns:** `Promise<boolean>` — `true` if the cache was successfully set, `false` otherwise.

---

#### `invalidate(options: CacheInvalidationOptions)`

Invalidates all cached items associated with the specified tags.

```typescript
await tagcache.invalidate({
  tags: ['user:123'],
  deleteCacheKeys: true
});
```

**Parameters (`CacheInvalidationOptions`):**
- `tags` (`string[]`): An array of tags to invalidate.
- `deleteCacheKeys` (`boolean`, optional):
  - `false` (Default - Soft Invalidation): Deletes only the tag sets in Redis. Cached entries remain in Redis but become unreachable via `get()` because tag-membership verification fails. They will naturally expire based on their TTL. This is highly performant because it avoids deleting many individual keys.
  - `true` (Hard Invalidation): Retrieves all cache keys associated with the tags and deletes both the tag sets and the actual cached data keys from Redis immediately.

**Returns:** `Promise<boolean>` — `true` if invalidation succeeded, `false` otherwise.

---

#### `isMember(options: IsMemberOptions)`

Checks if a cache key is currently associated with all specified tags in Redis.

```typescript
const isValid = await tagcache.isMember({
  key: 'user:profile:123',
  tags: ['users', 'user:123']
});
```

**Parameters (`IsMemberOptions`):**
- `key` (`string`): The original, un-prefixed cache key.
- `tags` (`string[]`): An array of tags to check against.

**Returns:** `Promise<boolean>` — `true` if the key is a member of all the specified tag sets, `false` otherwise.

---

#### `delete(options: CacheDeleteOptions)`

Explicitly and immediately deletes a cache key from Redis.

```typescript
await tagcache.delete({ key: 'user:profile:123' });
```

**Parameters (`CacheDeleteOptions`):**
- `key` (`string`): The original, un-prefixed cache key.

**Returns:** `Promise<boolean>` — `true` if deletion was successful, `false` otherwise.

---

### `TagcacheMiddleware`

An Express middleware wrapper for `TagCache` that enables automatic caching and invalidation of HTTP responses.

#### `constructor(options: TagcacheMiddlewareConstructorOpts)`

Initializes a new `TagcacheMiddleware` instance.

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `tagcache` | `TagCache` | **Yes** | — | An instance of the `TagCache` class. |
| `enable` | `boolean` | **Yes** | — | Toggles the middleware behavior. If `false`, all cache hits are bypassed, and invalidations are skipped. |

---

#### `cache(tags: TagInput[])`

Express middleware that automatically serves cached responses or captures and caches incoming successful JSON responses.

```typescript
app.get('/api/users/:id', 
  cacheMiddleware.cache([
    'users', 
    (req) => `user:${req.params.id}`
  ]),
  (req, res) => { ... }
);
```

**Parameters:**
- `tags` (`TagInput[]`): An array of static tags (`string`) or dynamic tag resolvers (`(req: Request) => string`).

**Key Features & Cache Key Generation:**
- **Cache Key**: A deterministic SHA-256 hash is generated using:
  - The request HTTP method (e.g., `GET`).
  - The request path (with trailing slashes normalized).
  - A sorted representation of `req.params`, `req.query`, and `req.body` (body is included only for `POST`, `PUT`, and `PATCH` requests).
- **HTTP Headers set**:
  - `X-Cache: HIT`: Served directly from the cache.
  - `X-Cache-Key`: The formatted cache key used in Redis (provided on cache hits).
  - `X-Cache: MISS`: The response was not cached; the interceptor will attempt to cache the response once the request completes.
  - `X-Cache: BYPASS`: Caching was bypassed due to configuration or headers.
- **Automatic Bypass**: Cache is bypassed if:
  - `enable` is set to `false`.
  - The request contains `Cache-Control: no-cache` or `Cache-Control: no-store` headers.
  - The request contains `Pragma: no-cache` header.
- **Caching Criteria**: Only responses meeting the following are cached:
  - HTTP status code is successful (`200` to `299`).
  - `Content-Type` header includes `application/json`.
  - The serialized body size does not exceed the configured `sizeGuard` limit.

---

#### `invalidate(tags: TagInput[])`

Express middleware that attaches a listener to invalidate the specified tags when a mutation response is successfully sent.

```typescript
app.put('/api/users/:id', 
  cacheMiddleware.invalidate([
    'users', 
    (req) => `user:${req.params.id}`
  ]),
  (req, res) => { ... }
);
```

**Parameters:**
- `tags` (`TagInput[]`): An array of static tags (`string`) or dynamic tag resolvers (`(req: Request) => string`).

**Behavior:**
- Resolves the tags dynamically from the request.
- Listens to the `finish` event of the response.
- If the response HTTP status code is successful (`200` to `304`), it automatically invalidates all resolved tags by calling `tagcache.invalidate({ tags, deleteCacheKeys: false })` (using soft invalidation for optimal performance).

## License

MIT
