# Changelog


## v2.4.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v2.3.0...v2.4.0)

### 🚀 Enhancements

- **core:** Add replicaLagMs write fence ([4be4e10](https://github.com/dsbalico/express-tag-cache/commit/4be4e10))
- **core:** Add hierarchicalTags option ([f0fef8d](https://github.com/dsbalico/express-tag-cache/commit/f0fef8d))
- **core:** Add ttlJitter option ([313f50e](https://github.com/dsbalico/express-tag-cache/commit/313f50e))
- Add onEvent hook for metrics and tracing ([c12db27](https://github.com/dsbalico/express-tag-cache/commit/c12db27))
- **core:** Add circuitBreaker option ([61c4627](https://github.com/dsbalico/express-tag-cache/commit/61c4627))
- **core:** Retry failed invalidations ([344d167](https://github.com/dsbalico/express-tag-cache/commit/344d167))
- **core:** Add lookup, staleTtl and refresh leases ([e8a56c8](https://github.com/dsbalico/express-tag-cache/commit/e8a56c8))
- **core:** Add stale-while-revalidate and stale-if-error to getOrSet ([ad79161](https://github.com/dsbalico/express-tag-cache/commit/ad79161))
- **middleware:** Add ttl, methods, key and skip options ([3043f63](https://github.com/dsbalico/express-tag-cache/commit/3043f63))
- **middleware:** Add setEnabled kill switch ([60e2513](https://github.com/dsbalico/express-tag-cache/commit/60e2513))
- **middleware:** Add authGuard option ([57acc5d](https://github.com/dsbalico/express-tag-cache/commit/57acc5d))
- **middleware:** Add staleWhileRevalidate option ([ef12355](https://github.com/dsbalico/express-tag-cache/commit/ef12355))
- **middleware:** Add staleIfError option ([aeafa7d](https://github.com/dsbalico/express-tag-cache/commit/aeafa7d))
- **middleware:** Add earlyRefresh option ([b8270d4](https://github.com/dsbalico/express-tag-cache/commit/b8270d4))
- **middleware:** Add sampled stale-data verification ([f207cd2](https://github.com/dsbalico/express-tag-cache/commit/f207cd2))
- **core:** Add inspectTag for invalidation previews ([4c90bce](https://github.com/dsbalico/express-tag-cache/commit/4c90bce))

### 🔥 Performance

- **core:** Add backgroundPurge option for hard invalidation ([29ccd82](https://github.com/dsbalico/express-tag-cache/commit/29ccd82))

### 🩹 Fixes

- **core:** Make tag version snapshots eviction-safe ([23a53ba](https://github.com/dsbalico/express-tag-cache/commit/23a53ba))
- **core:** Keep version tokens compatible with v2.3 instances ([e09081f](https://github.com/dsbalico/express-tag-cache/commit/e09081f))

### 📖 Documentation

- Document resilience, stale serving and observability options ([122bd20](https://github.com/dsbalico/express-tag-cache/commit/122bd20))

### 🏡 Chore

- Add benchmark script ([443cb34](https://github.com/dsbalico/express-tag-cache/commit/443cb34))

### ✅ Tests

- Close keep-alive sockets between server tests ([c523cd0](https://github.com/dsbalico/express-tag-cache/commit/c523cd0))
- Add concurrent stale-read checker against Redis ([96ef986](https://github.com/dsbalico/express-tag-cache/commit/96ef986))

### ❤️ Contributors

- Daniel Shan Balico <danielshan.balico@gmail.com>

## v2.3.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v2.2.0...v2.3.0)

### 🚀 Enhancements

- **core:** Add logger option ([e292411](https://github.com/dsbalico/express-tag-cache/commit/e292411))
- Skip caching data invalidated mid-request ([3e94360](https://github.com/dsbalico/express-tag-cache/commit/3e94360))
- **middleware:** Add vary option to cache() ([c81461e](https://github.com/dsbalico/express-tag-cache/commit/c81461e))
- **core:** Add operationTimeout option ([9a7af1d](https://github.com/dsbalico/express-tag-cache/commit/9a7af1d))
- **core:** Add getOrSet with shared loads ([37b66c5](https://github.com/dsbalico/express-tag-cache/commit/37b66c5))
- **middleware:** Add ignoreQuery option to cache() ([a536863](https://github.com/dsbalico/express-tag-cache/commit/a536863))
- **middleware:** Add coalesce option to cache() ([0e52927](https://github.com/dsbalico/express-tag-cache/commit/0e52927))

### 🔥 Performance

- **core:** Single round trip for soft invalidation ([258b34f](https://github.com/dsbalico/express-tag-cache/commit/258b34f))

### 🩹 Fixes

- **types:** Accept any node-redis v4/v5 client ([4fa4f6b](https://github.com/dsbalico/express-tag-cache/commit/4fa4f6b))
- **core:** Atomic writes, safe tag TTLs and expiry checks ([11ed74f](https://github.com/dsbalico/express-tag-cache/commit/11ed74f))
- **middleware:** Router-aware keys, exact body caching, invalidate before responding ([e2d07a9](https://github.com/dsbalico/express-tag-cache/commit/e2d07a9))

### 💅 Refactors

- **core:** Share error handling across methods ([fe0c52f](https://github.com/dsbalico/express-tag-cache/commit/fe0c52f))

### 📖 Documentation

- Rewrite README ([36ec2e7](https://github.com/dsbalico/express-tag-cache/commit/36ec2e7))
- Document stampede protection and production notes ([f1ff31f](https://github.com/dsbalico/express-tag-cache/commit/f1ff31f))

### 📦 Build

- Tighten package config and fix audit issues ([6ce7c3a](https://github.com/dsbalico/express-tag-cache/commit/6ce7c3a))

### ✅ Tests

- Add Redis integration tests and run them in CI ([764b0b4](https://github.com/dsbalico/express-tag-cache/commit/764b0b4))

### ❤️ Contributors

- Daniel Shan Balico <danielshan.balico@gmail.com>

## v2.2.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v2.1.0...v2.2.0)

### 🚀 Enhancements

- Add subpath exports and legacy typescript type resolution ([000effd](https://github.com/dsbalico/express-tag-cache/commit/000effd))
- Add tagIndexMaintenanceMode configuration to toggle strict vs lazy pruning ([3795530](https://github.com/dsbalico/express-tag-cache/commit/3795530))

### 🔥 Performance

- **middleware:** Optimize cache key generation and fix serialization bugs ([1ff8e70](https://github.com/dsbalico/express-tag-cache/commit/1ff8e70))
- **core:** Prevent stale tag memory leaks using Redis Sorted Sets ([7712ba8](https://github.com/dsbalico/express-tag-cache/commit/7712ba8))

### 📖 Documentation

- Update README to document tagIndexMaintenanceMode configuration ([4459d0d](https://github.com/dsbalico/express-tag-cache/commit/4459d0d))

### ✅ Tests

- Add strict and lazy tagIndexMaintenanceMode coverage for get, invalidate, and isMember ([562aad3](https://github.com/dsbalico/express-tag-cache/commit/562aad3))

### ❤️ Contributors

- Dsbalico <danielshan.balico@gmail.com>

## v2.1.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v2.0.0...v2.1.0)

### 🚀 Enhancements

- **middleware:** Support res.send() caching alongside res.json() ([b9aa04f](https://github.com/dsbalico/express-tag-cache/commit/b9aa04f))

### 🔥 Performance

- **redis:** Implement non-blocking UNLINK for cache invalidation and deletions ([c2b4290](https://github.com/dsbalico/express-tag-cache/commit/c2b4290))

### 🩹 Fixes

- **middleware:** Resolve double-prefixing of cache keys ([f031619](https://github.com/dsbalico/express-tag-cache/commit/f031619))

### 📖 Documentation

- **readme:** Document deleteCacheKeys in constructor options ([2ff1f5b](https://github.com/dsbalico/express-tag-cache/commit/2ff1f5b))

### 🏡 Chore

- Remove redundant root config folder ([6ee16cc](https://github.com/dsbalico/express-tag-cache/commit/6ee16cc))
- Align and expand npm keywords in package.json ([480da02](https://github.com/dsbalico/express-tag-cache/commit/480da02))

### ❤️ Contributors

- Dsbalico <danielshan.balico@gmail.com>

## v2.0.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v1.1.0...v2.0.0)

### 🚀 Enhancements

- **middleware:** ⚠️  Migrate invalidate signature to options object ([99cfdc6](https://github.com/dsbalico/express-tag-cache/commit/99cfdc6))

### 🔥 Performance

- **middleware:** Stream raw JSON directly on cache hits ([9d55575](https://github.com/dsbalico/express-tag-cache/commit/9d55575))

### 📖 Documentation

- **readme:** Document new invalidate options and breaking changes ([8fdedb0](https://github.com/dsbalico/express-tag-cache/commit/8fdedb0))

#### ⚠️ Breaking Changes

- **middleware:** ⚠️  Migrate invalidate signature to options object ([99cfdc6](https://github.com/dsbalico/express-tag-cache/commit/99cfdc6))

### ❤️ Contributors

- Dsbalico <danielshan.balico@gmail.com>

## v1.1.0

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v1.0.2...v1.1.0)

### 🚀 Enhancements

- Support cross-service cache operations via optional appContext parameter ([c52b865](https://github.com/dsbalico/express-tag-cache/commit/c52b865))

### 🩹 Fixes

- Correct middleware test assertion to include appContext in cross-service invalidation ([c9d0fce](https://github.com/dsbalico/express-tag-cache/commit/c9d0fce))

### 📖 Documentation

- Add cross-service appContext usage and API reference to README ([e33248b](https://github.com/dsbalico/express-tag-cache/commit/e33248b))

### 🏡 Chore

- Enhance README with badges for project metrics ([afd2826](https://github.com/dsbalico/express-tag-cache/commit/afd2826))
- Upgrade vitest from v1 to v4 ([3ffe4a7](https://github.com/dsbalico/express-tag-cache/commit/3ffe4a7))

### ❤️ Contributors

- Dsbalico <danielshan.balico@gmail.com>
- Daniel Shan Balico <danielshan.balico@gmail.com>

## v1.0.2

[compare changes](https://github.com/dsbalico/express-tag-cache/compare/v1.0.1...v1.0.2)

### 🏡 Chore

- Update README.md ([678d7dc](https://github.com/dsbalico/express-tag-cache/commit/678d7dc))

### ❤️ Contributors

- Daniel Shan Balico <81-dsbalico@users.noreply.157.245.154.249>

## v1.0.1


### 🏡 Chore

- Add changelog generator ([bbf8d42](https://github.com/dsbalico/express-tag-cache/commit/bbf8d42))
- **workflow:** Add ci action ([f8f8d33](https://github.com/dsbalico/express-tag-cache/commit/f8f8d33))
- **workflow:** Add publish action ([f9d4a92](https://github.com/dsbalico/express-tag-cache/commit/f9d4a92))
- Specify package manager ([6e0cfd2](https://github.com/dsbalico/express-tag-cache/commit/6e0cfd2))

### ❤️ Contributors

- Mon Albert Gamil <mrgamilmonalbert@gmail.com>

