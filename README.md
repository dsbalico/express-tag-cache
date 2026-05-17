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
  appContext: 'my-app'
});

const cacheMiddleware = new TagcacheMiddleware({
  tagcache,
  enable: true
});
```

### 2. Use Middleware to Cache Routes

```typescript
import express from 'express';

const app = express();

app.get('/api/products', 
  cacheMiddleware.cache(['products', 'list']), 
  async (req, res) => {
    // Data fetching logic...
    res.json({ products: [] });
  }
);
```

### 3. Invalidate Cache via Middleware

```typescript
app.post('/api/products', 
  cacheMiddleware.invalidate(['products']), 
  async (req, res) => {
    // Product creation logic...
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
  cacheTtl: 3600
});

// Get cache manually
const cachedData = await tagcache.get({
  key: 'user:123',
  tags: ['users'] // Will return null if any tag was invalidated
});

// Invalidate tags manually
await tagcache.invalidate({
  tags: ['user:123'],
  deleteCacheKeys: true
});
```

## API Reference

### `TagCache`
- `constructor(options: TagCacheOptions)`
- `get(options: CacheFetchOptions)`
- `set(options: CacheStoreOptions)`
- `invalidate(options: CacheInvalidationOptions)`
- `isMember(options: IsMemberOptions)`
- `delete(options: CacheDeleteOptions)`

### `TagcacheMiddleware`
- `cache(tags: TagInput[])`: Middleware to serve from cache or store response in cache.
- `invalidate(tags: TagInput[])`: Middleware to invalidate tags on successful response.

## License

MIT
