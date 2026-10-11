import { request } from 'node:http';
import { vi } from 'vitest';

export type Command = [name: string, ...args: unknown[]];

export interface ScriptOptions {
    keys: string[];
    arguments: string[];
}

const BATCH_COMMANDS = ['get', 'set', 'zRemRangeByScore', 'zScore', 'zRange', 'unlink', 'incr', 'expire'] as const;

/**
 * A node-redis client stand-in. `multi()` batches record their commands in `batches`; each
 * `exec()` resolves to the next entry queued with `queueExec()`, or else to replies derived from
 * the batch: `'OK'` for SET, the value SET earlier in the same batch for GET, `null` otherwise.
 */
export function createMockRedis() {
    const batches: { commands: Command[] }[] = [];
    const execResults: unknown[][] = [];

    const redis = {
        isReady: true,
        isOpen: true,
        multi: vi.fn(() => {
            const batch: Record<string, unknown> & { commands: Command[] } = { commands: [] };
            for (const name of BATCH_COMMANDS) {
                batch[name] = vi.fn((...args: unknown[]) => {
                    batch.commands.push([name, ...args]);
                    return batch;
                });
            }
            const queued = execResults.shift();
            batch.exec = vi.fn(async () => queued ?? defaultReplies(batch.commands));
            batches.push(batch);
            return batch;
        }),
        evalSha: vi.fn(async (_sha: string, _options: ScriptOptions): Promise<unknown> => 1),
        eval: vi.fn(async (_script: string, _options: ScriptOptions): Promise<unknown> => 1),
        unlink: vi.fn(async (..._args: unknown[]): Promise<unknown> => 1),
        set: vi.fn(async (..._args: unknown[]): Promise<unknown> => 'OK'),
        scanKeys: [] as string[][],
        scanIterator: vi.fn(async function* (this: unknown, _options: { MATCH: string; COUNT: number }) {
            for (const keys of redis.scanKeys) yield keys;
        }),
    };

    return {
        redis,
        batches,
        queueExec: (...results: unknown[][]) => execResults.push(...results),
    };
}

function defaultReplies(commands: Command[]): unknown[] {
    const written = new Map<unknown, unknown>();
    return commands.map(([name, key, value]) => {
        if (name === 'set') {
            if (!written.has(key)) written.set(key, value);
            return 'OK';
        }
        return name === 'get' ? written.get(key) ?? null : null;
    });
}

/** A tag index score (expiry timestamp) that is still in the future. */
export const future = () => Date.now() + 60_000;

/** A tag index score (expiry timestamp) that has already passed. */
export const past = () => Date.now() - 1;

export interface HttpResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

/** One HTTP request on its own connection (no keep-alive), so no socket outlives the test that opened it. */
export function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const req = request(url, { method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end(init.body);
    });
}
