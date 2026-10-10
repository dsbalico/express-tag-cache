import type { Request, Response, NextFunction } from "express";
import type {
    TagInput,
    TagcacheMiddlewareCacheOpts,
    TagcacheMiddlewareConstructorOpts,
    TagcacheMiddlewareInvalidateOpts,
} from "./types/middleware.js";
import {
    attachCacheWriter,
    attachInvalidationListener,
    bypassCache,
    generateCacheKey,
    logError,
    resolveTags,
    serveCachedResponse,
} from "./utils/tagcache-middleware-utils.js";

/**
 * Express middleware factory that caches JSON responses in a TagCache and invalidates them by tag.
 *
 * @example
 * const middleware = new TagcacheMiddleware({ tagcache, enable: true });
 * app.get('/products/:id', middleware.cache(['products', (req) => `product:${req.params.id}`]), handler);
 * app.put('/products/:id', middleware.invalidate(['products', (req) => `product:${req.params.id}`]), handler);
 */
export class TagcacheMiddleware {
    private readonly config: TagcacheMiddlewareConstructorOpts;

    constructor(config: TagcacheMiddlewareConstructorOpts) {
        this.config = config;
    }

    /**
     * Returns middleware that serves a cached response when one exists (`X-Cache: HIT`) and
     * otherwise lets the route run (`X-Cache: MISS`), caching its response if it is a 2xx JSON
     * response without `Set-Cookie` or `Cache-Control: private|no-store`. If a tag is
     * invalidated while the route runs, its response is not cached.
     *
     * The cache key covers the method, full path, params, query, the body for POST/PUT/PATCH,
     * and `options.vary`. It does not cover headers or cookies.
     *
     * @param tags Tags for the cached response; requests whose tags all resolve to empty strings are not cached.
     * @param options `vary` adds request-specific input (such as the user ID) to the cache key.
     */
    public cache(tags: TagInput[], options?: TagcacheMiddlewareCacheOpts) {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (bypassCache({ req, enable: this.config.enable })) {
                res.setHeader("X-Cache", "BYPASS");
                return next();
            }

            const { tagcache } = this.config;
            try {
                const resolvedTags = resolveTags({ req, tags });
                if (!resolvedTags.length) return next();

                const cacheKey = generateCacheKey(req, options?.vary);
                const cached = await tagcache.get({ key: cacheKey, tags: resolvedTags });
                if (cached !== null) return serveCachedResponse(res, tagcache, cacheKey, cached);

                res.setHeader("X-Cache", "MISS");
                const versions = await tagcache.getTagVersions({ tags: resolvedTags });
                if (versions) attachCacheWriter({ res, tagcache, cacheKey, tags: resolvedTags, versions });
            } catch (error) {
                logError(tagcache, "[TagCache] cache() middleware error:", error);
                if (res.headersSent) return;
            }
            return next();
        };
    }

    /**
     * Returns middleware that invalidates `tags` when the route responds with a status from
     * 200 to 304. The response is finished only after invalidation completes, so clients never
     * read a stale entry right after a successful mutation.
     *
     * @param tags Tags to invalidate.
     * @param options Overrides for `deleteCacheKeys` and `appContext`.
     */
    public invalidate(tags: TagInput[], options?: TagcacheMiddlewareInvalidateOpts) {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (!this.config.enable) return next();

            const { tagcache } = this.config;
            try {
                const resolvedTags = resolveTags({ req, tags });
                if (resolvedTags.length) {
                    attachInvalidationListener({
                        res,
                        tagcache,
                        tags: resolvedTags,
                        appContext: options?.appContext ?? tagcache.cacheOptions.appContext,
                        deleteCacheKeys: options?.deleteCacheKeys ?? tagcache.cacheOptions.deleteCacheKeys,
                    });
                }
            } catch (error) {
                logError(tagcache, "[TagCache] invalidate() middleware error:", error);
            }
            return next();
        };
    }
}
