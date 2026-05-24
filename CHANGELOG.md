# Changelog


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

