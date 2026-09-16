/**
 * TASK-982 §3.4.5 — `recordRunFinished` merges `skippedNodeCount` into `_metadata`, and
 * `WorkflowRunDtoMapper` reads it back out (plus the derived `degraded` flag).
 *
 * There is NO `skippedNodeCount` column (`workflow-run.prisma` carries only
 * `nodeCount`/`failedNodeCount`/`degradedNodeCount`), so the value is written into the row's
 * existing `_metadata` bag — the SAME accessor `actingUserId` already uses (TASK-950). It must be
 * MERGED, never a wholesale replace: `recordRunStarted` may already have stamped `actingUserId`
 * into that bag, and a replace would silently clobber it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunFactory, WorkflowRunStatus } from '@arcaai/domains';
import { WorkflowRunDtoMapper } from '../workflow-run.dto.mapper';
import { WorkflowRunService, interpreterSessionId } from '../workflow-run.service';

const TENANT = 'tenant-1';
const RUN_ID = 'run-1';
const SESSION_ID = interpreterSessionId(RUN_ID);
const ACTING_USER = '70000000-0000-0000-0000-0000000009e5';

function buildRun(overrides: Partial<Parameters<typeof WorkflowRunFactory.CreateRun>[0]> = {}) {
  return WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'wfv-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 3,
    definitionName: 'Triage Workflow',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    trigger: 'api invoke',
    startedAt: new Date('2026-08-16T10:00:00.000Z'),
    ...overrides,
  });
}

function buildDeps() {
  const repository = {
    findByRunKey: vi.fn().mockResolvedValue(null),
    updateWithVersion: vi.fn().mockImplementation((_id: string, entity: unknown) => Promise.resolve(entity)),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue(undefined) };
  const service = new WorkflowRunService(repository as never, eventEmitter as never, clsService as never);
  return { service, repository };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-982 — recordRunFinished merges skippedNodeCount into _metadata', () => {
  it('stamps skippedNodeCount into an EMPTY metaData bag', async () => {
    const { service, repository } = buildDeps();
    const existing = buildRun();
    repository.findByRunKey.mockResolvedValueOnce(existing);

    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'COMPLETED', skippedNodeCount: 3 });

    expect(existing.metaData).toEqual({ skippedNodeCount: 3 });
  });

  it('MERGES with a pre-existing metaData bag — does not clobber actingUserId', async () => {
    const { service, repository } = buildDeps();
    const existing = buildRun({ metaData: { actingUserId: ACTING_USER } });
    repository.findByRunKey.mockResolvedValueOnce(existing);

    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'COMPLETED', skippedNodeCount: 1 });

    expect(existing.metaData).toEqual({ actingUserId: ACTING_USER, skippedNodeCount: 1 });
  });

  it('leaves metaData untouched when the caller omits skippedNodeCount', async () => {
    const { service, repository } = buildDeps();
    const existing = buildRun({ metaData: { actingUserId: ACTING_USER } });
    repository.findByRunKey.mockResolvedValueOnce(existing);

    // A status-only finish still has something to persist (the status transition), so the update
    // proceeds — but the metaData bag must be untouched.
    await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'COMPLETED' });

    expect(existing.metaData).toEqual({ actingUserId: ACTING_USER });
  });
});

describe('TASK-982 — WorkflowRunDtoMapper.skippedNodeCount + degraded', () => {
  it('reads skippedNodeCount back out of metaData, narrowed to a number', () => {
    expect(WorkflowRunDtoMapper.toResponse(buildRun({ metaData: { skippedNodeCount: 2 } })).skippedNodeCount).toBe(2);
    expect(WorkflowRunDtoMapper.toResponse(buildRun()).skippedNodeCount).toBeNull();
    expect(WorkflowRunDtoMapper.toResponse(buildRun({ metaData: { skippedNodeCount: 'two' } })).skippedNodeCount).toBeNull();
  });

  it('degraded is false on a COMPLETED run with zero degraded/skipped nodes', () => {
    const run = buildRun({ status: WorkflowRunStatus.COMPLETED, degradedNodeCount: 0 });
    expect(WorkflowRunDtoMapper.toResponse(run).degraded).toBe(false);
  });

  it('degraded is true on a COMPLETED run with a degraded node', () => {
    const run = buildRun({ status: WorkflowRunStatus.COMPLETED, degradedNodeCount: 1 });
    expect(WorkflowRunDtoMapper.toResponse(run).degraded).toBe(true);
  });

  it('a skipped node alone never makes a run degraded — a hand-off or an untaken branch is not a warning', () => {
    const run = buildRun({ status: WorkflowRunStatus.COMPLETED, degradedNodeCount: 0, metaData: { skippedNodeCount: 2 } });
    expect(WorkflowRunDtoMapper.toResponse(run).degraded).toBe(false);
    expect(WorkflowRunDtoMapper.toResponse(run).skippedNodeCount).toBe(2);
  });

  it('degraded is a per-run flag, never a run status — a FAILED run with a degraded count is not "degraded"', () => {
    const run = buildRun({ status: WorkflowRunStatus.FAILED, degradedNodeCount: 1 });
    expect(WorkflowRunDtoMapper.toResponse(run).degraded).toBe(false);
  });
});
