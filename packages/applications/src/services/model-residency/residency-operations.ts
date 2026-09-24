import type { ResidencyOperationStatus } from './model-residency.types';

/**
 * TASK-1005 — the in-memory record of asynchronous loads.
 *
 * A 5 GB LM Studio load takes ~100 s (§10.1), past Cloudflare's 100 s edge
 * timeout for a browser request, so an operator load answers 202 with an
 * operation id and runs in the background; the console polls
 * `GET operations/:id`. BOUNDED: once `capacity` is reached the oldest
 * FINISHED record is dropped (a running one never is). Per process and lost on
 * restart — an operation is progress reporting, not state; the durable record
 * of what happened is the sys-event audit trail.
 */

export interface ResidencyOperation {
  id: string;
  action: 'load' | 'replace';
  service: string;
  modelRef: string;
  status: ResidencyOperationStatus;
  error: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export class ResidencyOperationRegistry {
  private readonly operations = new Map<string, ResidencyOperation>();

  constructor(private readonly capacity = 200) {}

  start(op: Pick<ResidencyOperation, 'id' | 'action' | 'service' | 'modelRef'>, now = new Date()): ResidencyOperation {
    const record: ResidencyOperation = { ...op, status: 'running', error: null, startedAt: now.toISOString(), finishedAt: null };
    this.operations.set(record.id, record);
    this.trim();
    return record;
  }

  succeed(id: string, now = new Date()): void {
    const op = this.operations.get(id);
    if (op) Object.assign(op, { status: 'succeeded', finishedAt: now.toISOString() });
  }

  fail(id: string, error: { code: string; message: string }, now = new Date()): void {
    const op = this.operations.get(id);
    if (op) Object.assign(op, { status: 'failed', error, finishedAt: now.toISOString() });
  }

  get(id: string): ResidencyOperation | undefined {
    const op = this.operations.get(id);
    return op ? { ...op } : undefined;
  }

  /** The running operation for this (service, model), if any. */
  runningFor(service: string, modelRef: string): ResidencyOperation | undefined {
    for (const op of this.operations.values()) {
      if (op.status === 'running' && op.service === service && op.modelRef === modelRef) return { ...op };
    }
    return undefined;
  }

  running(): ResidencyOperation[] {
    return [...this.operations.values()].filter((op) => op.status === 'running').map((op) => ({ ...op }));
  }

  private trim(): void {
    if (this.operations.size <= this.capacity) return;
    for (const [id, op] of this.operations) {
      if (this.operations.size <= this.capacity) return;
      if (op.status !== 'running') this.operations.delete(id);
    }
  }
}
