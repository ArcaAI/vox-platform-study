/**
 * TASK-790 (finding M-2, requested by TASK-791) — a run's delivered OUTPUT is recordable and
 * readable back.
 *
 * `output.deliver` is the summarization palette's only `external_write` node. It performs a real
 * write and then had nowhere to record WHAT it wrote: no column, no callback, and
 * `getRunStatus()` reads Temporal state only. So a run's generated content was unrecoverable the
 * moment the run finished — the node's own docstring names this as a disclosed gap for the runs
 * ticket to close.
 *
 * SHAPE — verified against `deliver.py`, not against the request. The node returns a
 * DISCRIMINATED UNION, `{"resultRef": ClaimCheckRef}` when claim-check is enabled AND
 * `should_offload()` says the blob is big enough, otherwise `{"outputs": {...}}` INLINE. A column
 * recording only the pointer would silently drop the inline branch — the common one for a short
 * note — so the column stores the node's `output` object verbatim and both branches round-trip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowRunService } from '../workflow-run.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = { findByRunKey: vi.fn(), update: vi.fn(), create: vi.fn(), findById: vi.fn() };

const CLAIM_CHECK_OUTPUT = { resultRef: { bucket: 'harness-claim-check', key: 'sha256/abc', sizeBytes: 4096 } };
const INLINE_OUTPUT = { outputs: { note: 'Patient reports improvement.' } };

const runEntity = (overrides: Record<string, unknown> = {}) => {
  const changes: Record<string, unknown> = {};
  return {
    id: 'run-row-1',
    tenantId: 'tenant-1',
    workflowVersionId: 'def-1',
    workflowSlug: 'discharge_summary',
    workflowVersionNumber: 1,
    definitionName: 'Discharge Summary',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    status: 'RUNNING',
    isSandbox: false,
    startedAt: new Date('2026-08-22T00:00:00Z'),
    endedAt: null,
    durationMs: null,
    nodeCount: null,
    failedNodeCount: 0,
    degradedNodeCount: 0,
    firstErrorCode: null,
    resultRef: null,
    createdAt: new Date('2026-08-22T00:00:00Z'),
    updatedAt: new Date('2026-08-22T00:00:00Z'),
    version: 1,
    tags: [],
    get hasChanges() {
      return Object.keys(changes).length > 0;
    },
    get changes() {
      return changes;
    },
    ...overrides,
  } as any;
};

function build() {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  return new WorkflowRunService(mockRepository as any, mockEventEmitter as any, mockClsService as any);
}

describe('TASK-790 M-2 — WorkflowRun.resultRef', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);
  });

  it('recordRunFinished persists the claim-check branch', async () => {
    const entity = runEntity();
    mockRepository.findByRunKey.mockResolvedValue(entity);

    const result = await build().recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      status: 'COMPLETED',
      resultRef: CLAIM_CHECK_OUTPUT,
    } as any);

    expect(entity.resultRef).toEqual(CLAIM_CHECK_OUTPUT);
    expect(result.resultRef).toEqual(CLAIM_CHECK_OUTPUT);
  });

  it('recordRunFinished persists the INLINE branch — the one a pointer-only column would drop', async () => {
    const entity = runEntity();
    mockRepository.findByRunKey.mockResolvedValue(entity);

    const result = await build().recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      status: 'COMPLETED',
      resultRef: INLINE_OUTPUT,
    } as any);

    expect(result.resultRef).toEqual(INLINE_OUTPUT);
  });

  it('leaves resultRef untouched when the caller omits it — a graph with no output.deliver node', async () => {
    const entity = runEntity({ resultRef: CLAIM_CHECK_OUTPUT });
    mockRepository.findByRunKey.mockResolvedValue(entity);

    const result = await build().recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      status: 'COMPLETED',
    } as any);

    expect(result.resultRef).toEqual(CLAIM_CHECK_OUTPUT);
  });

  it('a RUNNING run reads back null — nothing delivered yet', async () => {
    const entity = runEntity();
    mockRepository.findByRunKey.mockResolvedValue(entity);

    const result = await build().recordRunFinished({
      tenantId: 'tenant-1',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      status: 'RUNNING',
    } as any);

    expect(result.resultRef).toBeNull();
  });
});
