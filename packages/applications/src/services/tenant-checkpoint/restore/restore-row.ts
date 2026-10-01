/**
 * Durable restore job state on the `TenantCheckpointRestore` row (this row IS the tenant lock):
 * re-read → apply → compare-and-set writes, a never-overlapping heartbeat, and the restore's
 * direct database access (`pg`, because COPY).
 */
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import type { TenantCheckpointRestoreEntity, TenantCheckpointRestoreRepository } from '@arcaai/domains';
import type { Pool, PoolClient } from 'pg';

import { CheckpointError, type SqlQuery } from '../contracts';
import { createCheckpointPool, sqlQueryOver } from '../db/checkpoint-pg';

export type RestoreRows = Pick<TenantCheckpointRestoreRepository, 'findById' | 'updateWithVersion'>;

export const TERMINAL_RESTORE_STATUSES: readonly string[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'];

export async function findRestore(repo: Pick<RestoreRows, 'findById'>, id: string): Promise<TenantCheckpointRestoreEntity | null> {
  try {
    return (await repo.findById(id)) ?? null;
  } catch (error) {
    if (error instanceof DataNotFoundException) return null;
    throw error;
  }
}

/** Re-read, apply `edit`, write with the version just read; `edit` returning false skips the write. */
export async function patchRestore(
  repo: RestoreRows,
  id: string,
  edit: (row: TenantCheckpointRestoreEntity) => boolean | void,
  attempts = 5,
): Promise<TenantCheckpointRestoreEntity | null> {
  for (let attempt = 1; ; attempt++) {
    const row = await findRestore(repo, id);
    if (!row || edit(row) === false) return null;
    try {
      return await repo.updateWithVersion(id, row, row.version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException && attempt < attempts) continue;
      throw error;
    }
  }
}

/** Interval runner that never overlaps itself and never lets a failed beat escape. */
export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(
    private readonly intervalMs: number,
    private readonly beat: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.beat()
        .catch(this.onError)
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** `failureReason` + `failureDetail` — never a stack, never a driver message (it may quote row values). */
export function describeRestoreFailure(error: unknown): { reason: string; detail: string } {
  if (error instanceof CheckpointError) return { reason: error.reason, detail: (error.message.split('\n')[0] ?? '').slice(0, 500) };
  const name = error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  const codePart = typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `, code ${code}` : '';
  return { reason: 'RESTORE_FAILED', detail: `The restore failed (${name}${codePart}).` };
}

/** The restore's own database access: one client for the reconcile transaction, plain queries otherwise. */
export interface RestoreDb {
  connect(): Promise<PoolClient>;
  query: SqlQuery;
}
export const CHECKPOINT_RESTORE_DB = Symbol('CHECKPOINT_RESTORE_DB');

/** `pg` over `DIRECT_URL`; the pool is created on first use. */
export class PgRestoreDb implements RestoreDb {
  private pool?: Pool;

  async connect(): Promise<PoolClient> {
    this.pool ??= createCheckpointPool();
    return this.pool.connect();
  }

  query: SqlQuery = <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
    this.pool ??= createCheckpointPool();
    return sqlQueryOver(this.pool as never)<T>(sql, params);
  };

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}

/** Time source of the runner; the unit tests swap it for a fake clock. */
export interface RestoreClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const RESTORE_CLOCK = Symbol('RESTORE_CLOCK');
export const realClock: RestoreClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
