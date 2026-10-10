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
        unlink: vi.fn(async () => 1),
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
