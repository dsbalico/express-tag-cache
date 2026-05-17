import type { Request, Response, NextFunction } from "express";
import { TagInput, TagcacheMiddlewareConstructorOpts } from "./types/middleware.js";
import { attachCacheWriter, attachInvalidationListener, bypassCache, resolveTags, tryServeFromCache } from "./utils/tagcache-middleware-utils.js";

export class TagcacheMiddleware {
    private readonly config: TagcacheMiddlewareConstructorOpts;

    constructor(config: TagcacheMiddlewareConstructorOpts) {
        this.config = config;
    }

    public cache(tags: TagInput[]) {
        return async (req: Request, res: Response, next: NextFunction) => {
            if (bypassCache({ req, enable: this.config.enable })) {
                res.setHeader("X-Cache", "BYPASS");
                return next();
            }

            try {
                const resolvedTags = resolveTags({ req, tags });

                if (!resolvedTags.length) return next();

                const served = await tryServeFromCache({
                    tagcache: this.config.tagcache,
                    tags: resolvedTags,
                    req,
                    res
                });

                if (served) return;

                attachCacheWriter({
                    req,
                    res,
                    tags: resolvedTags,
                    tagcache: this.config.tagcache
                });

                return next();

            } catch (error) {
                return next();
            }
        }
    }

    public invalidate(tags: TagInput[]) {
        return async (req: Request, res: Response, next: NextFunction) => {
            if (!this.config.enable) return next();
            
			try {
                const resolvedTags = resolveTags({ req, tags });

                if (!resolvedTags.length) return next();

                attachInvalidationListener({
                    res,
                    tags: resolvedTags,
                    tagcache: this.config.tagcache
                });

                return next();

            } catch (error) {
                return next();
            }
        }
    }
}