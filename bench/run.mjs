// Benchmarks against a real Redis: `REDIS_URL=redis://127.0.0.1:6379 npm run bench`.
// Server CPU is measured in a child process so the load generator does not distort it.
import { fork } from 'node:child_process';
import express from 'express';
import { createClient } from 'redis';
import { TagCache, TagcacheMiddleware } from '../dist/index.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    console.error('Set REDIS_URL, e.g. REDIS_URL=redis://127.0.0.1:6379 npm run bench');
    process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function connect() {
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    return redis;
}

async function listen(app) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// ---- child process: a server that reports its own CPU time ----
if (process.argv[2] === '--server') {
    const redis = await connect();
    const tagcache = new TagCache({ redis, appContext: `bench-${process.pid}` });
    const on = new TagcacheMiddleware({ tagcache, enable: true });
    const off = new TagcacheMiddleware({ tagcache, enable: false });
    const body = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}`, tags: ['a', 'b', 'c'], price: i * 1.5, desc: 'lorem ipsum dolor sit amet '.repeat(3) })) };
    const app = express();
    app.get('/miss', on.cache(['big']), (_req, res) => { res.json(body); });
    app.get('/hit', on.cache(['hit']), (_req, res) => { res.json(body); });
    app.get('/bypass', off.cache(['big']), (_req, res) => { res.json(body); });
    app.get('/cpu', (_req, res) => { const { user, system } = process.cpuUsage(); res.json({ us: user + system }); });
    const { base } = await listen(app);
    process.send({ base, kb: Math.round(JSON.stringify(body).length / 1024) });
} else {
    await main();
}

async function serverCpu() {
    const child = fork(new URL(import.meta.url), ['--server'], { stdio: 'inherit' });
    const { base, kb } = await new Promise((resolve) => child.once('message', resolve));
    const cpu = async () => (await (await fetch(`${base}/cpu`)).json()).us;
    const measure = async (path, unique) => {
        for (let i = 0; i < 50; i++) await (await fetch(`${base}${path}?warm=${i}`)).arrayBuffer();
        const samples = [];
        for (let rep = 0; rep < 5; rep++) {
            const before = await cpu();
            for (let i = 0; i < 300; i++) await (await fetch(`${base}${path}${unique ? `?r=${rep}&i=${i}` : ''}`)).arrayBuffer();
            await sleep(300);
            samples.push((await cpu() - before) / 300);
        }
        return Math.round(median(samples));
    };
    const result = { payloadKB: kb, bypassUs: await measure('/bypass', true), missUs: await measure('/miss', true), hitUs: await measure('/hit', false) };
    child.kill();
    return result;
}

async function stampede(redis) {
    const results = {};
    for (const coalesce of [false, true]) {
        const tagcache = new TagCache({ redis, appContext: `bench-stampede-${coalesce}` });
        const middleware = new TagcacheMiddleware({ tagcache, enable: true, coalesce });
        let runs = 0;
        const app = express();
        app.get('/item', middleware.cache(['items']), async (_req, res) => { runs++; await sleep(100); res.json({ ok: true }); });
        const { base, close } = await listen(app);
        for (let wave = 0; wave < 5; wave++) {
            await tagcache.invalidate({ tags: ['items'] });
            await Promise.all(Array.from({ length: 50 }, () => fetch(`${base}/item`).then((r) => r.text())));
        }
        close();
        results[coalesce ? 'coalesce' : 'noCoalesce'] = runs;
    }
    return { requests: 250, handlerRuns: results };
}

async function invalidation(redis) {
    const results = {};
    for (const [name, options, deleteCacheKeys] of [['soft', {}, false], ['hard', {}, true], ['hardBackgroundPurge', { backgroundPurge: true }, true]]) {
        const tagcache = new TagCache({ redis, appContext: `bench-inv-${name}`, ...options });
        const samples = [];
        for (let rep = 0; rep < 7; rep++) {
            for (let i = 0; i < 10_000; i += 500) await Promise.all(Array.from({ length: 500 }, (_, j) => tagcache.set({ key: `k${i + j}`, value: 'v', tags: ['bulk'] })));
            const started = process.hrtime.bigint();
            await tagcache.invalidate({ tags: ['bulk'], deleteCacheKeys });
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
            await sleep(100);
        }
        results[name] = +median(samples).toFixed(2);
    }
    return { members: 10_000, medianMs: results };
}

async function latency(redis) {
    const tagcache = new TagCache({ redis, appContext: 'bench-latency' });
    const value = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'x'.repeat(20) })) });
    const time = async (operation) => {
        const started = process.hrtime.bigint();
        for (let i = 0; i < 3000; i++) await operation(i);
        return +(Number(process.hrtime.bigint() - started) / 1e3 / 3000).toFixed(1);
    };
    await time((i) => tagcache.set({ key: `warm${i}`, value, tags: ['a', 'b'] }));
    return { setUs: await time((i) => tagcache.set({ key: `k${i}`, value, tags: ['a', 'b'] })), getUs: await time((i) => tagcache.get({ key: `k${i}`, tags: ['a', 'b'] })) };
}

async function main() {
    const redis = await connect();
    try {
        const report = {
            serverCpuPerRequest: await serverCpu(),
            stampede: await stampede(redis),
            invalidation: await invalidation(redis),
            latency: await latency(redis),
        };
        console.log(JSON.stringify(report, null, 2));
    } finally {
        for await (const keys of redis.scanIterator({ MATCH: 'bench-*', COUNT: 1000 })) {
            const batch = Array.isArray(keys) ? keys : [keys];
            if (batch.length) await redis.unlink(batch);
        }
        await redis.quit();
    }
}
