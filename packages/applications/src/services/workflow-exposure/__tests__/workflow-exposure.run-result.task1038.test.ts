/**
 * TASK-1038 — the delivery plane's read side on the exposure service.
 *
 * D-I: `getRunResult` serves what a run DELIVERED — inline JSON, or a short-lived signed URL for
 * a claim-checked result — to the business-plane caller that started it. Before, no terminal
 * path persisted a result at all, so `WorkflowRun.resultRef` was always null and an API caller
 * had no way to read the output.
 *
 * Status fallback: a run the harness no longer knows (404) is answered from the read model
 * instead of failing the status read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY } from '../../settings-registry/descriptors/workflow-runs.descriptors';
import { WorkflowExposureService } from '../workflow-exposure.service';

const TENANT = 'tenant-1';
const mockClsService = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockHarnessGateway = { getWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunFinished: vi.fn() };
const mockConfigService = { getConfigValue: vi.fn() };
const mockBlobStorage = { presignGet: vi.fn() };
const mockTenantSettings = {
  resolve: vi.fn(),
  resolvePlatform: vi.fn((key: string) => ({ key, value: key === WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY ? 120 : undefined })),
};

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    tenantId: TENANT,
    workflowSlug: 'discharge_summary',
    workflowVersionId: 'def-1',
    workflowVersionNumber: 3,
    sessionId: 'workflow-interpreter-run-1',
    status: 'COMPLETED',
    startedAt: '2026-10-04T00:00:00.000Z',
    endedAt: '2026-10-04T00:01:00.000Z',
    resultRef: null,
    ...overrides,
  };
}

function build() {
  const positional: unknown[] = [
    {} /* workflowDefinitionRepository */,
    mockHarnessGateway,
    mockWorkflowRunService,
    mockConfigService,
    mockEventEmitter,
    mockClsService,
    undefined /* s3 */,
    undefined /* redis */,
    undefined /* entitlements */,
    undefined /* consultation */,
    undefined /* webhook secrets */,
    undefined /* secrets */,
    mockTenantSettings,
    undefined /* user identity */,
    undefined /* billing */,
    undefined /* context schemas */,
    undefined /* effective trigger schema */,
    mockBlobStorage,
  ];
  return new (WorkflowExposureService as unknown as new (...args: unknown[]) => WorkflowExposureService)(...positional);
}

const upstream = (status: string) => ({ runId: 'run-1', status, stages: [], startedAt: '2026-10-04T00:00:00.000Z', endedAt: null });

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkflowRunService.recordRunFinished.mockResolvedValue(undefined);
  mockHarnessGateway.getWorkflowRun.mockResolvedValue(upstream('SUCCEEDED'));
});

describe('TASK-1038 D-I — getRunResult', () => {
  it('returns an inline result as the JSON value', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'inline', value: { note: 'SOAP' } } }));
    const result = await build().getRunResult('discharge_summary', 'run-1');
    expect(result).toEqual(expect.objectContaining({ kind: 'inline', value: { note: 'SOAP' }, runId: 'run-1', status: 'COMPLETED' }));
  });

  it('signs a short-lived GET URL for a claim-checked result, for workflowRuns.resultUrlTtlSeconds', async () => {
    const ref = {
      kind: 'ref',
      bucket: 'tenant-1-bucket',
      key: 'tenant-1/runs/run-1/result.json' /* TASK-1038 E2 fix 13: tenant-prefixed */,
      sizeBytes: 300_000,
      sha256: 'f'.repeat(64),
    };
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: ref }));
    mockBlobStorage.presignGet.mockResolvedValue('https://minio.example/signed');
    const before = Date.now();

    const result = await build().getRunResult('discharge_summary', 'run-1');

    expect(mockBlobStorage.presignGet).toHaveBeenCalledWith({ bucket: ref.bucket, key: ref.key, expiresInSeconds: 120 });
    expect(result).toEqual(expect.objectContaining({ kind: 'ref', url: 'https://minio.example/signed', sizeBytes: 300_000, sha256: ref.sha256 }));
    const expiresAt = Date.parse((result as { expiresAt: string }).expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('refuses with 409 and the current status while the run is still going', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ status: 'RUNNING' }));
    mockHarnessGateway.getWorkflowRun.mockResolvedValue(upstream('RUNNING'));
    const attempt = build().getRunResult('discharge_summary', 'run-1');
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await attempt.catch((err: ConflictException) => {
      expect(err.getResponse()).toEqual(expect.objectContaining({ code: 'RUN_NOT_TERMINAL', status: 'RUNNING' }));
    });
  });

  it('a read model still RUNNING but a terminal harness: reconciles, then answers', async () => {
    mockWorkflowRunService.getRun
      .mockResolvedValueOnce(runRow({ status: 'RUNNING' }))
      .mockResolvedValueOnce(runRow({ status: 'RUNNING' }))
      .mockResolvedValue(runRow({ status: 'COMPLETED', resultRef: { kind: 'inline', value: 42 } }));
    const result = await build().getRunResult('discharge_summary', 'run-1');
    expect(result).toEqual(expect.objectContaining({ kind: 'inline', value: 42 }));
  });

  it('answers kind none for a terminal run that delivered nothing, and kind expired after the purge', async () => {
    mockWorkflowRunService.getRun.mockResolvedValueOnce(runRow({ status: 'FAILED', resultRef: null }));
    expect(await build().getRunResult('discharge_summary', 'run-1')).toEqual(expect.objectContaining({ kind: 'none', status: 'FAILED' }));
    mockWorkflowRunService.getRun.mockResolvedValueOnce(runRow({ resultRef: { kind: 'expired', expiredAt: '2026-11-03T04:45:00.000Z' } }));
    expect(await build().getRunResult('discharge_summary', 'run-1')).toEqual(
      expect.objectContaining({ kind: 'expired', expiredAt: '2026-11-03T04:45:00.000Z' }),
    );
  });

  it('is a 404 for another tenant`s run and for a run of another workflow (404-over-403)', async () => {
    mockWorkflowRunService.getRun.mockRejectedValueOnce(new NotFoundException('WorkflowRun run-1 not found'));
    await expect(build().getRunResult('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
    mockWorkflowRunService.getRun.mockResolvedValueOnce(runRow({ workflowSlug: 'other_flow' }));
    await expect(build().getRunResult('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockBlobStorage.presignGet).not.toHaveBeenCalled();
  });

  it('audits every result read — the output is PHI', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'inline', value: 'x' } }));
    await build().getRunResult('discharge_summary', 'run-1');
    const [, event] = mockEventEmitter.emit.mock.calls.at(-1)!;
    expect(event).toEqual(
      expect.objectContaining({ forceAuditLog: true, data: expect.objectContaining({ action: 'readResult', runId: 'run-1', kind: 'inline' }) }),
    );
  });
});

describe('TASK-1038 — status falls back to the read model when the harness has no record', () => {
  it('answers from the read model on a harness 404', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ status: 'COMPLETED', resultRef: { kind: 'inline', value: 1 } }));
    mockHarnessGateway.getWorkflowRun.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }),
    );

    const status = await build().getRunStatus('discharge_summary', 'run-1');

    expect(status).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: 'COMPLETED',
        startedAt: '2026-10-04T00:00:00.000Z',
        endedAt: '2026-10-04T00:01:00.000Z',
        stages: [],
      }),
    );
    expect(mockWorkflowRunService.recordRunFinished).not.toHaveBeenCalled();
  });

  it('still fails on any other harness error — only "no record" is answered from the read model', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow());
    mockHarnessGateway.getWorkflowRun.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 503 } }));
    await expect(build().getRunStatus('discharge_summary', 'run-1')).rejects.toThrow('boom');
  });

  it('persists a result the harness status read carries, when it carries one', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ status: 'RUNNING' }));
    const result = { kind: 'inline', value: { ok: true } };
    mockHarnessGateway.getWorkflowRun.mockResolvedValue({ ...upstream('SUCCEEDED'), result });
    await build().getRunStatus('discharge_summary', 'run-1');
    expect(mockWorkflowRunService.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED', resultRef: result }));
  });
});
