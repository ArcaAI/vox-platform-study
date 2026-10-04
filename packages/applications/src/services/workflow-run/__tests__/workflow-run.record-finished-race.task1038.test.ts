/**
 * TASK-1038 E2 (fix 5) — `recordRunFinished` never loses a delivered result to a race.
 *
 * Two writers close a run: `syncTerminalStatus` (a status read — usually NO result) and the
 * completion watcher (the completed event — WITH the result). Both read the row at `_version` N.
 * When the status sync wins, the watcher's `updateWithVersion` used to throw
 * `OptimisticConcurrencyException` and the result was gone for good. Now a conflict re-reads and
 * re-applies, and a non-null `resultRef` is never overwritten with `null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { WorkflowRun, WorkflowRunEntityMapper, WorkflowRunFactory, type WorkflowRunEntity } from '@arcaai/domains';
import { WorkflowRunService } from '../workflow-run.service';

const TENANT = 'tenant-1';
const SESSION = 'workflow-interpreter-run-1';
const RESULT = { kind: 'inline', value: { note: 'Discharged.' } };

class FakeRepo {
  row: Record<string, unknown>;
  /** Called inside `updateWithVersion` before the compare — lets a test land a rival write first. */
  beforeUpdate: (() => void) | null = null;
  private readonly mapper = WorkflowRunEntityMapper.getInstance();

  constructor() {
    const entity = WorkflowRunFactory.CreateRun({
      tenantId: TENANT,
      workflowVersionId: 'def-1',
      workflowSlug: 'discharge',
      workflowVersionNumber: 1,
      definitionName: 'Discharge',
      sessionId: SESSION,
      runId: 'run-1',
      trigger: 'api invoke',
      startedAt: new Date('2026-10-05T00:00:00Z'),
    });
    this.row = { ...this.revive(this.mapper.toPersistence(entity) as never), version: 1 };
  }

  findByRunKey = vi.fn(async (_tenantId: string, sessionId: string) => (sessionId === SESSION ? this.entity() : null));

  updateWithVersion = vi.fn(async (_id: string, entity: WorkflowRunEntity, expected: number) => {
    const hook = this.beforeUpdate;
    this.beforeUpdate = null;
    hook?.();
    if (this.row.version !== expected) {
      throw new OptimisticConcurrencyException('workflowRun', String(this.row.id), {
        expectedVersion: expected,
        currentVersion: this.row.version as number,
      });
    }
    this.row = { ...this.row, ...this.revive(this.mapper.toPersistenceChanges(entity) as never), version: (this.row.version as number) + 1 };
    return this.entity();
  });

  /** A rival writer's terminal write that carries no result (the status sync). */
  rivalStatusOnlyWrite(): void {
    this.row = { ...this.row, status: 'COMPLETED', endedAt: new Date('2026-10-05T00:01:00Z'), version: (this.row.version as number) + 1 };
  }

  entity(): WorkflowRunEntity {
    return this.mapper.toDomainEntity(new WorkflowRun(structuredClone(this.row) as never));
  }

  private revive(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    for (const column of ['startedAt', 'endedAt', 'createdAt', 'updatedAt'])
      if (typeof out[column] === 'string') out[column] = new Date(out[column] as string);
    return out;
  }
}

let repo: FakeRepo;
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn() };
const emitter = { emit: vi.fn() };
const service = () => new WorkflowRunService(repo as never, emitter as never, cls as never);

beforeEach(() => {
  repo = new FakeRepo();
  vi.clearAllMocks();
});

describe('recordRunFinished under a concurrent terminal write', () => {
  it('the completion watcher’s result survives losing the race to the status sync (OCC → re-read, re-apply)', async () => {
    repo.beforeUpdate = () => repo.rivalStatusOnlyWrite();
    const saved = await service().recordRunFinished({ tenantId: TENANT, sessionId: SESSION, runId: 'run-1', status: 'COMPLETED', resultRef: RESULT });
    expect(saved.resultRef).toEqual(RESULT);
    expect(repo.row.resultRef).toEqual(RESULT);
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(2);
  });

  it('a later write that carries `null` never clears a result already persisted', async () => {
    await service().recordRunFinished({ tenantId: TENANT, sessionId: SESSION, runId: 'run-1', status: 'COMPLETED', resultRef: RESULT });
    await service().recordRunFinished({ tenantId: TENANT, sessionId: SESSION, runId: 'run-1', status: 'COMPLETED', resultRef: null });
    expect(repo.row.resultRef).toEqual(RESULT);
  });

  it('gives up (rethrows) only after repeated conflicts', async () => {
    let rivals = 10;
    repo.updateWithVersion.mockImplementation(async (_id: string, _entity: WorkflowRunEntity, expected: number) => {
      if (rivals-- > 0) throw new OptimisticConcurrencyException('workflowRun', 'x', { expectedVersion: expected, currentVersion: expected + 1 });
      return repo.entity();
    });
    await expect(
      service().recordRunFinished({ tenantId: TENANT, sessionId: SESSION, runId: 'run-1', status: 'COMPLETED', resultRef: RESULT }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });
});
