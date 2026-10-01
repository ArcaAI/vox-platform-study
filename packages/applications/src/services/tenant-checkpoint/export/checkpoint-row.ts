/**
 * Durable job state on the `TenantCheckpoint` row: re-read → apply → compare-and-set writes, and
 * the 15 s liveness heartbeat. The heartbeat and the job's own writes race on `_version`; the
 * job retries its writes, the heartbeat drops a clash (the next beat retries).
 */
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import type { TenantCheckpointEntity, TenantCheckpointRepository } from '@arcaai/domains';

import { CheckpointError } from '../contracts';

export type CheckpointRows = Pick<TenantCheckpointRepository, 'findById' | 'updateWithVersion'>;

/**
 * Re-read the row, apply `edit` and write it with the version just read. `edit` returning `false`
 * skips the write (and resolves `null`); a missing row also resolves `null`.
 */
export async function patchCheckpoint(
  repo: CheckpointRows,
  id: string,
  edit: (row: TenantCheckpointEntity) => boolean | void,
  attempts = 5,
): Promise<TenantCheckpointEntity | null> {
  for (let attempt = 1; ; attempt++) {
    const row = await findCheckpoint(repo, id);
    if (!row || edit(row) === false) return null;
    try {
      return await repo.updateWithVersion(id, row, row.version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException && attempt < attempts) continue;
      throw error;
    }
  }
}

export async function findCheckpoint(repo: Pick<CheckpointRows, 'findById'>, id: string): Promise<TenantCheckpointEntity | null> {
  try {
    return await repo.findById(id);
  } catch (error) {
    if (error instanceof DataNotFoundException) return null;
    throw error;
  }
}

/** Interval runner that never overlaps itself and never lets a failed beat escape. */
export class RowHeartbeat {
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

/** A heartbeat write: liveness + progress, OCC clashes dropped. Reports a recorded cancel. */
export async function writeHeartbeat(
  repo: CheckpointRows,
  id: string,
  now: Date,
  progress: Record<string, unknown>,
  onCancelRequested: () => void,
): Promise<void> {
  const row = await findCheckpoint(repo, id);
  if (!row || row.status !== 'RUNNING') return;
  if (row.cancelRequestedAt) onCancelRequested();
  row.heartbeatAt = now;
  row.progress = { ...progress } as never;
  try {
    await repo.updateWithVersion(id, row, row.version);
  } catch (error) {
    if (error instanceof OptimisticConcurrencyException) return;
    throw error;
  }
}

/**
 * `failureReason` + `failureDetail` for a failed job. A `CheckpointError` message is authored by
 * this feature and kept (first line, bounded); any other error is reduced to its class and a
 * short code — a driver message can quote row values, and a stack is never stored.
 */
export function describeFailure(error: unknown, fallback: 'EXPORT_FAILED' | 'RESTORE_FAILED' = 'EXPORT_FAILED'): { reason: string; detail: string } {
  if (error instanceof CheckpointError) {
    return { reason: error.reason, detail: firstLine(error.message) };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const codePart = typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `, code ${code}` : '';
  return { reason: fallback, detail: `The job failed (${/^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error'}${codePart}).` };
}

function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').slice(0, 500);
}
