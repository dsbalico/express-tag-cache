import type { Request, Response, NextFunction } from "express";
import type { CacheLookupResult } from "./types/tagcache.js";
import type {
    AuthGuardMode,
    TagInput,
    TagcacheMiddlewareCacheOpts,
    TagcacheMiddlewareConstructorOpts,
    TagcacheMiddlewareInvalidateOpts,
} from "./types/middleware.js";
import {
    attachCacheWriter,
    attachInvalidationListener,
    bypassReason,
    createQueryFilter,
    emit,
    generateCacheKey,
    logError,
    resolveTags,
    routeOf,
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
    /** Responses being produced for coalesced requests, by cache key; resolve to the cached body or `null`. */
    private readonly pending = new Map<string, Promise<string | null>>();
    /** Whether `cache()` serves and stores responses. */
    private serving: boolean;
    /** Whether `invalidate()` invalidates; stays on once caching has been enabled. */
    private invalidating: boolean;
    /** Routes already warned about by `authGuard: 'warn'`. */
    private readonly warnedRoutes = new Set<string>();

    constructor(config: TagcacheMiddlewareConstructorOpts) {
        this.config = config;
        this.serving = config.enable;
        this.invalidating = config.enable;
    }

    /** Whether `cache()` currently serves and stores responses. */
    public get enabled(): boolean {
        return this.serving;
    }

    /**
     * Turns caching on or off at runtime, e.g. from a feature flag or an incident runbook.
     *
     * Turning it off makes `cache()` pass every request through (`X-Cache: BYPASS`) but keeps
     * `invalidate()` invalidating, so turning it back on never serves data that changed meanwhile.
     */
    public setEnabled(enabled: boolean): void {
        this.serving = enabled;
        if (enabled) this.invalidating = true;
    }

    /**
     * Returns middleware that serves a cached response when one exists (`X-Cache: HIT`) and
     * otherwise lets the route run (`X-Cache: MISS`), caching its response if it is a 200 JSON
     * response without `Set-Cookie`, `Cache-Control: private|no-store`, or a `Vary` on request
     * headers the key does not cover. If a tag is invalidated while the route runs, its response
     * is not cached.
     *
     * The cache key covers the method, full path, params, query, the body for POST/PUT/PATCH,
     * and `options.vary`. It does not cover headers or cookies.
     *
     * @param tags Tags for the cached response; requests whose tags all resolve to empty strings are not cached.
     * @param options Key, TTL, method and bypass rules, plus stampede and stale-serving behavior;
     *   see {@link TagcacheMiddlewareCacheOpts}.
     */
    public cache(tags: TagInput[], options?: TagcacheMiddlewareCacheOpts) {
        const keyOptions = { vary: options?.vary, ignoreQuery: createQueryFilter(options?.ignoreQuery), key: options?.key };
        const methods = options?.methods?.length ? new Set(options.methods.map((method) => method.toUpperCase())) : undefined;
        // A route that keys on something request-specific is assumed to have handled per-user data.
        const authGuard: AuthGuardMode = options?.vary || options?.key ? "off" : (options?.authGuard ?? this.config.authGuard ?? "off");
        const honorRequestCacheControl = options?.honorRequestCacheControl ?? this.config.honorRequestCacheControl ?? true;
        const coalesce = options?.coalesce ?? this.config.coalesce ?? false;
        const policy: RoutePolicy = {
            coalesce: coalesce !== false,
            coalesceTimeoutMs: typeof coalesce === "object" ? positiveOr(coalesce.timeoutMs, 0) : 0,
            revalidateMs: secondsToMs(options?.staleWhileRevalidate),
            errorMs: secondsToMs(options?.staleIfError),
            earlyBeta: options?.earlyRefresh ? positiveOr(options.earlyRefresh === true ? undefined : options.earlyRefresh.beta, 1) : 0,
            routeMs: 0,
            verifyRate: Math.min(1, positiveOr(options?.verify?.sampleRate, 0)),
            compare: options?.verify?.compare ?? ((cached, fresh) => cached === fresh),
        };
        const readsStale = policy.revalidateMs > 0 || policy.errorMs > 0 || policy.earlyBeta > 0;
        const onDuration = policy.earlyBeta ? (ms: number) => { policy.routeMs = policy.routeMs ? policy.routeMs * 0.8 + ms * 0.2 : ms; } : undefined;

        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const { tagcache } = this.config;
            const route = routeOf(req);
            const bypass = this.bypassReason(req, route, methods, options?.skip, authGuard, honorRequestCacheControl);
            if (bypass) {
                res.setHeader("X-Cache", "BYPASS");
                emit(tagcache, { type: "bypass", reason: bypass, route });
                return next();
            }

            const run: RouteRun = { cacheKey: "", route };
            let finished = false;
            const finish = (value: string | null) => {
                if (finished) return;
                finished = true;
                run.settle?.(value);
                if (run.lease) void tagcache.releaseLease({ key: run.cacheKey, token: run.lease });
            };
            try {
                const resolvedTags = resolveTags({ req, tags });
                if (!resolvedTags.length) return next();

                run.cacheKey = generateCacheKey(req, keyOptions);
                const entry = await this.read(run.cacheKey, resolvedTags, readsStale);
                if (await this.tryServe(res, entry, policy, run)) return;

                res.setHeader("X-Cache", "MISS");
                emit(tagcache, { type: "miss", key: run.cacheKey, route });
                const versions = await tagcache.getTagVersions({ tags: resolvedTags });
                if (versions) {
                    attachCacheWriter({
                        res, tagcache, cacheKey: run.cacheKey, tags: resolvedTags, versions, route,
                        ttl: options?.ttl, fallback: run.fallback, onSettled: finish, onDuration,
                        verify: run.verify === undefined ? undefined : { cached: run.verify, compare: policy.compare },
                        routeVaries: Boolean(options?.vary || options?.key),
                    });
                } else {
                    finish(null);
                }
            } catch (error) {
                finish(null);
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
            if (!this.invalidating) return next();

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

    /**
     * Serves the request from the cache if it should be, and returns whether it did. Otherwise the
     * route must run; `run` then says whether it holds a refresh lease, leads a coalesced group,
     * and which cached body to fall back to if the route fails.
     */
    private async tryServe(res: Response, entry: CacheLookupResult | null, policy: RoutePolicy, run: RouteRun): Promise<boolean> {
        const { tagcache } = this.config;
        const { cacheKey, route } = run;

        if (entry && !entry.stale) {
            if (policy.verifyRate && Math.random() < policy.verifyRate) {
                emit(tagcache, { type: "refresh", key: cacheKey, reason: "verify", route });
                run.verify = entry.value;
                run.fallback = { value: entry.value, stale: false };
                return false;
            }
            if (!(await this.refreshesEarly(entry, policy, run))) {
                emit(tagcache, { type: "hit", key: cacheKey, source: "redis", route });
                serveCachedResponse(res, tagcache, cacheKey, entry.value);
                return true;
            }
            // If the early refresh fails, the still-valid entry is served.
            emit(tagcache, { type: "refresh", key: cacheKey, reason: "early", route });
            run.fallback = { value: entry.value, stale: false };
            run.settle = this.lead(cacheKey);
            return false;
        }

        const age = entry ? Date.now() - entry.expiresAt : Infinity;
        if (entry && policy.errorMs > 0 && age <= policy.errorMs) run.fallback = { value: entry.value, stale: true };

        if (entry && policy.revalidateMs > 0 && age <= policy.revalidateMs) {
            // Serve the stale entry unless this request wins the right to refresh it.
            run.lease = this.pending.has(cacheKey) ? null : await tagcache.acquireLease({ key: cacheKey, ttlMs: REFRESH_LEASE_MS });
            if (!run.lease) {
                emit(tagcache, { type: "hit", key: cacheKey, source: "stale", route });
                serveCachedResponse(res, tagcache, cacheKey, entry.value, "STALE");
                return true;
            }
            emit(tagcache, { type: "refresh", key: cacheKey, reason: "stale", route });
            run.settle = this.lead(cacheKey);
            return false;
        }

        if (policy.coalesce) {
            const pending = this.pending.get(cacheKey);
            if (!pending) {
                run.settle = this.lead(cacheKey);
                return false;
            }
            const shared = await waitFor(pending, policy.coalesceTimeoutMs);
            if (shared !== null) {
                emit(tagcache, { type: "hit", key: cacheKey, source: "coalesced", route });
                serveCachedResponse(res, tagcache, cacheKey, shared);
                return true;
            }
            // The first request's response was not cacheable, or took too long; run the route like any miss.
        }
        return false;
    }

    /**
     * XFetch: refresh a fresh entry early with a probability that rises as expiry nears and with how
     * long the route takes. Takes the refresh lease when it decides to; returns whether it did.
     */
    private async refreshesEarly(entry: CacheLookupResult, policy: RoutePolicy, run: RouteRun): Promise<boolean> {
        if (!policy.earlyBeta || !policy.routeMs || this.pending.has(run.cacheKey)) return false;
        if (Date.now() - policy.routeMs * policy.earlyBeta * Math.log(Math.random()) < entry.expiresAt) return false;
        run.lease = await this.config.tagcache.acquireLease({ key: run.cacheKey, ttlMs: REFRESH_LEASE_MS });
        return run.lease !== null;
    }

    /** Reads the entry for a request; with `withStale`, also entries within the TagCache's `staleTtl`. */
    private async read(key: string, tags: string[], withStale: boolean): Promise<CacheLookupResult | null> {
        const { tagcache } = this.config;
        if (withStale) return tagcache.lookup({ key, tags });
        const value = await tagcache.get({ key, tags });
        return value === null ? null : { value, expiresAt: Infinity, stale: false };
    }

    /**
     * Why this request skips the cache, if it does: disabled, method not cached, `skip()`, an
     * `Authorization` header under `authGuard: 'skip'`, or request headers asking to skip caches
     * (when `honorRequestCacheControl`).
     */
    private bypassReason(req: Request, route: string, methods: Set<string> | undefined, skip: ((req: Request) => boolean) | undefined, authGuard: AuthGuardMode, honorRequestCacheControl: boolean) {
        if (!this.serving) return "disabled";
        if (methods && !methods.has(req.method)) return "method";
        if (skip) {
            try {
                if (skip(req)) return "skipped";
            } catch (error) {
                logError(this.config.tagcache, "[TagCache] skip() threw; bypassing the cache:", error);
                return "skipped";
            }
        }
        if (authGuard !== "off" && req.headers.authorization !== undefined) {
            if (authGuard === "skip") return "authorization";
            this.warnOnce(route, `[TagCache] ${route} caches requests with an Authorization header but has no vary or key option; responses may be served to other users.`);
        }
        return honorRequestCacheControl ? bypassReason(req, true) : null;
    }

    private warnOnce(route: string, message: string): void {
        if (this.warnedRoutes.has(route)) return;
        this.warnedRoutes.add(route);
        const { logger } = this.config.tagcache;
        if (logger?.warn) logger.warn(message);
        else (logger ?? console).error(message);
    }

    /**
     * Registers the current request as the one producing the response for `cacheKey`. Returns the
     * function that publishes its outcome to waiting requests and clears the registration.
     */
    private lead(cacheKey: string): (value: string | null) => void {
        let resolve!: (value: string | null) => void;
        const pending = new Promise<string | null>((r) => { resolve = r; });
        this.pending.set(cacheKey, pending);
        return (value) => {
            if (this.pending.get(cacheKey) === pending) this.pending.delete(cacheKey);
            resolve(value);
        };
    }
}

/** Per-route settings of `cache()`, plus the route's measured duration for `earlyRefresh`. */
interface RoutePolicy {
    coalesce: boolean;
    /** Longest a coalesced request waits; 0 for no limit. */
    coalesceTimeoutMs: number;
    revalidateMs: number;
    errorMs: number;
    /** XFetch beta; 0 when `earlyRefresh` is off. */
    earlyBeta: number;
    /** Moving average of how long the route takes, in milliseconds. */
    routeMs: number;
    /** Fraction of hits re-computed by `verify`; 0 when off. */
    verifyRate: number;
    compare: (cached: string, fresh: string) => boolean;
}

/** What one request through `cache()` holds while its route runs. */
interface RouteRun {
    cacheKey: string;
    route: string;
    /** Refresh lease token, released when the response settles. */
    lease?: string | null;
    /** Publishes the response to coalesced requests waiting on this one. */
    settle?: (value: string | null) => void;
    /** Cached entry to serve if the route fails with a 5xx. */
    fallback?: { value: string; stale: boolean };
    /** Cached body this run re-computes for `verify`. */
    verify?: string;
}

/** How long a refresh lease lasts if the refreshing request never finishes. */
const REFRESH_LEASE_MS = 10_000;

/** Resolves to what `pending` resolves to, or to `null` if that takes longer than `ms` (0: no limit). */
async function waitFor(pending: Promise<string | null>, ms: number): Promise<string | null> {
    if (!ms) return pending;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(resolve, ms, null); });
    try {
        return await Promise.race([pending, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** `value` if it is a finite number above zero, otherwise `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Converts an optional whole-seconds option to milliseconds; anything invalid becomes 0. */
function secondsToMs(seconds: number | undefined): number {
    return Number.isSafeInteger(seconds) && (seconds as number) > 0 ? (seconds as number) * 1000 : 0;
}
