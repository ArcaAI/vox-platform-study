/**
 * TASK-1022 A2 — `recordRunSuperseded` closes a SUPERSEDED governing run's row without rewriting
 * history.
 *
 * Live evidence (replay run5): the superseded run had already COMPLETED at 04:01:51; the governed
 * resume's `recordRunFinished({ status: 'CANCELED', endedAt: now })` rewrote it to CANCELED with
 * the supersede time. A finished run's terminal status and `endedAt` are facts, not the
 * supersede's to change. Only a row still RUNNING becomes CANCELED (ended now); every row gets
 * the supersede provenance (`_metadata.supersededBy`), merged into the existing bag.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceType, SysEventType, WorkflowRunFactory, WorkflowRunStatus } from '@arcaai/domains';
import { WorkflowRunService } from '../workflow-run.service';

const TENANT = 'tenant-1';
const OLD_RUN = 'run-old';
const NEW_RUN = 'run-new';
const SESSION_ID = `wf-${OLD_RUN}`;
const STARTED = new Date('2026-09-30T03:58:00.000Z');
const ENDED = new Date('2026-09-30T04:01:51.000Z');

function buildRun(overrides: Partial<Parameters<typeof WorkflowRunFactory.CreateRun>[0]> = {}) {
  return WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'wfv-1',
    workflowSlug: 'consultation-note',
    workflowVersionNumber: 3,
    definitionName: 'Consultation note',
    sessionId: SESSION_ID,
    runId: OLD_RUN,
    trigger: 'consultation open',
    startedAt: STARTED,
    ...overrides,
  });
}

function buildDeps(row: ReturnType<typeof buildRun> | null) {
  const repository = {
    findByRunKey: vi.fn().mockResolvedValue(row),
    updateWithVersion: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue(undefined) };
  const service = new WorkflowRunService(repository as never, eventEmitter as never, clsService as never);
  return { service, repository, eventEmitter };
}

const input = {
  tenantId: TENANT,
  sessionId: SESSION_ID,
  runId: OLD_RUN,
  supersededBy: NEW_RUN,
  terminalReason: `superseded by ${NEW_RUN}`,
  consultationId: 'c-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-1022 A2 — recordRunSuperseded', () => {
  it('a COMPLETED row keeps its status and endedAt; only the supersede provenance is added', async () => {
    const row = buildRun({
      status: WorkflowRunStatus.COMPLETED,
      endedAt: ENDED,
      durationMs: ENDED.getTime() - STARTED.getTime(),
      metaData: { actingUserId: 'u-1' },
    });
    const { service, repository, eventEmitter } = buildDeps(row);

    const result = await service.recordRunSuperseded(input);

    expect(row.status).toBe(WorkflowRunStatus.COMPLETED);
    expect(row.endedAt).toEqual(ENDED);
    expect(row.durationMs).toBe(ENDED.getTime() - STARTED.getTime());
    expect(row.metaData).toEqual({ actingUserId: 'u-1', supersededBy: NEW_RUN });
    expect(repository.updateWithVersion).toHaveBeenCalledOnce();
    expect(result.status).toBe(WorkflowRunStatus.COMPLETED);
    // Not a status transition — no run-finished webhook fires a second time.
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it.each([WorkflowRunStatus.FAILED, WorkflowRunStatus.CANCELED, WorkflowRunStatus.TIMED_OUT])(
    'a %s row keeps its status and endedAt',
    async (status) => {
      const row = buildRun({ status, endedAt: ENDED });
      const { service } = buildDeps(row);

      await service.recordRunSuperseded(input);

      expect(row.status).toBe(status);
      expect(row.endedAt).toEqual(ENDED);
      expect(row.metaData).toEqual({ supersededBy: NEW_RUN });
    },
  );

  it('a RUNNING row becomes CANCELED, ended now, with provenance and the run-finished event', async () => {
    const row = buildRun();
    const { service, eventEmitter } = buildDeps(row);
    const before = Date.now();

    await service.recordRunSuperseded(input);

    expect(row.status).toBe(WorkflowRunStatus.CANCELED);
    expect(row.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.durationMs).toBe(row.endedAt!.getTime() - STARTED.getTime());
    expect(row.metaData).toEqual({ supersededBy: NEW_RUN });
    expect(eventEmitter.emit).toHaveBeenCalledOnce();
    const [type, event] = eventEmitter.emit.mock.calls[0]!;
    expect(type).toBe(SysEventType.ResourceUpdated);
    expect(event.resourceType).toBe(ResourceType.WorkflowRun);
    expect(event.data).toMatchObject({
      action: 'runFinished',
      runId: OLD_RUN,
      status: 'CANCELED',
      terminalReason: input.terminalReason,
      consultationId: 'c-1',
    });
  });

  it('re-reads on a concurrent terminal write and then leaves the terminal status alone', async () => {
    const running = buildRun();
    const completed = buildRun({ status: WorkflowRunStatus.COMPLETED, endedAt: ENDED });
    const { service, repository } = buildDeps(running);
    repository.findByRunKey.mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    repository.updateWithVersion
      .mockRejectedValueOnce(new OptimisticConcurrencyException('WorkflowRun', running.id, { expectedVersion: 1, currentVersion: 2 }))
      .mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity));

    await service.recordRunSuperseded(input);

    expect(repository.updateWithVersion).toHaveBeenCalledTimes(2);
    expect(completed.status).toBe(WorkflowRunStatus.COMPLETED);
    expect(completed.endedAt).toEqual(ENDED);
    expect(completed.metaData).toEqual({ supersededBy: NEW_RUN });
  });

  it('an already-stamped row writes nothing', async () => {
    const row = buildRun({ status: WorkflowRunStatus.COMPLETED, endedAt: ENDED, metaData: { supersededBy: NEW_RUN } });
    const { service, repository } = buildDeps(row);

    await service.recordRunSuperseded(input);

    expect(repository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a missing row is a 404, like recordRunFinished', async () => {
    const { service } = buildDeps(null);
    await expect(service.recordRunSuperseded(input)).rejects.toThrow(/not found/);
  });
});
