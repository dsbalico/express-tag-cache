import crypto from 'crypto';
import type { Response } from 'express';

import {
    SortObjectOptions,
    BypassCacheOptions,
    ResolveTagsOptions,
    GenerateCacheKeyOptions,
    TryServeFromCacheOptions,
    AttachCacheWriterOptions,
    ShouldCacheResponseOptions,
    AttachInvalidationListenerOptions,
} from '../types/middleware.js';

import { formatPrefixedKey } from './tagcache-utils.js';

function sortObject({ value }: SortObjectOptions): any {
    if (Array.isArray(value)) return value.map(v => sortObject({ value: v }));

    if (value !== null && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((acc: Record<string, any>, key: string) => {
                acc[key] = sortObject({ value: value[key] });
                return acc;
            }, {});
    }

    return value;
}

function generateCacheKey({ req, options }: GenerateCacheKeyOptions): string {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/$/, "");

    const merged: Record<string, any> = { params: req.params, query: req.query };

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        merged.body = req.body;
    }

    const sorted = sortObject({ value: merged });
    const rawKey = `${method}:${path}:${JSON.stringify(sorted)}`;
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");

    return formatPrefixedKey(hash, options.cachePrefix, options.appContext);
}

function shouldCacheResponse({ res, body }: ShouldCacheResponseOptions): boolean {
    if (res.statusCode < 200 || res.statusCode >= 300) return false;
    if (body === undefined || body === null) return false;

    const contentType = String(res.getHeader("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) return false;

    return true;
}

export function bypassCache({ req, enable }: BypassCacheOptions): boolean {
    if (!enable) return true;

    const cacheControl = req.headers["cache-control"];

    if (typeof cacheControl === "string") {
        const cc = cacheControl.toLowerCase();
        if (cc.includes("no-cache") || cc.includes("no-store")) {
            return true;
        }
    }

    if (req.headers["pragma"] === "no-cache") return true;

    return false;
}

export function resolveTags({ req, tags }: ResolveTagsOptions): string[] {
    return [...new Set(
        tags
            .map((tag: any) => (typeof tag === "function" ? tag(req) : tag))
            .map((tag: any) => String(tag ?? "").trim())
            .filter(Boolean) as string[]
    )];
}

export async function tryServeFromCache({ tagcache, tags, req, res }: TryServeFromCacheOptions): Promise<boolean> {
    const cacheKey = generateCacheKey({ req, options: tagcache.cacheOptions });

    const value = await tagcache.get({ key: cacheKey, tags });

    if (!value) {
        res.setHeader("X-Cache", "MISS");
        return false;
    }

    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Cache-Key", cacheKey);
    res.status(200).type("json").send(value);
    return true;
}

export function attachCacheWriter({ req, res, tags, tagcache }: AttachCacheWriterOptions) {
    let responseBody: unknown;
    let isCaptured = false;

    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
        responseBody = body;
        isCaptured = true;
        return originalJson(body);
    } as Response["json"];

    res.once("finish", async () => {
        try {
            if (!isCaptured) return;
            if (!shouldCacheResponse({ res, body: responseBody })) return;

            const cacheKey = generateCacheKey({ req, options: tagcache.cacheOptions });
            const serialized = JSON.stringify(responseBody);

            if (serialized.length > tagcache.cacheOptions.sizeGuard * 1024) return;

            await tagcache.set({
                key: cacheKey,
                value: serialized,
                tags
            });
        } catch (error) {
            console.error("Cache write error:", error);
        }
    });
}

export function attachInvalidationListener({ res, tags, tagcache, deleteCacheKeys, appContext }: AttachInvalidationListenerOptions) {
    res.once("finish", async () => {
        try {
            if ((res.statusCode < 200 || res.statusCode > 304) || !tags.length) return;

            await tagcache.invalidate({ tags, deleteCacheKeys, appContext });
        } catch (error) {
            console.error("[TagCache] Cache invalidation error:", error);
        }
    });
}