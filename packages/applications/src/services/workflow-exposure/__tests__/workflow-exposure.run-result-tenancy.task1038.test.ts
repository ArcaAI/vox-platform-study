/**
 * TASK-1038 E2 (fix 13) — a claim-checked result is signed only when its object is the run
 * tenant's.
 *
 * `GET …/runs/:runId/result` signs a GET URL for whatever `{ kind: 'ref', bucket, key }` the run
 * row holds. The harness now writes run results under the tenant prefix `<tenantId>/` (lane E3);
 * a key outside it — a content-addressed key shared across tenants, or a producer bug — could hand
 * one tenant a URL to another tenant's object. Such a key is refused with the house 404 and
 * nothing is signed.
 *
 * Legacy un-prefixed keys are refused too. The stored shape is the frozen protocol v2
 * `run.completed.result` (`{ kind, bucket, key, sizeBytes, sha256 }`, closed), so no producer flag
 * can mark a pre-change row, and the gateway cannot prove an un-prefixed object belongs to the
 * caller; such a result reads 404 rather than leak.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
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

describe('getRunResult — result object tenancy', () => {
  const sha = 'f'.repeat(64);

  it('signs a ref whose key is under `<tenantId>/`', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'ref', bucket: 'harness-claim-check', key: `${TENANT}/runs/run-1/result.json`, sizeBytes: 9, sha256: sha } }));
    mockBlobStorage.presignGet.mockResolvedValue('https://minio.example/signed');
    const result = await build().getRunResult('discharge_summary', 'run-1');
    expect(result).toMatchObject({ kind: 'ref', url: 'https://minio.example/signed' });
  });

  it('refuses (404) a key under ANOTHER tenant’s prefix and signs nothing', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'ref', bucket: 'harness-claim-check', key: 'tenant-2/runs/x/result.json', sizeBytes: 9, sha256: sha } }));
    await expect(build().getRunResult('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockBlobStorage.presignGet).not.toHaveBeenCalled();
  });

  it('refuses (404) a legacy un-prefixed key and signs nothing', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'ref', bucket: 'harness-claim-check', key: `sha256/${sha}`, sizeBytes: 9, sha256: sha } }));
    await expect(build().getRunResult('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockBlobStorage.presignGet).not.toHaveBeenCalled();
  });

  it('a prefix that merely STARTS with the tenant id (no separator) is not the tenant’s', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue(runRow({ resultRef: { kind: 'ref', bucket: 'b', key: `${TENANT}-evil/result.json`, sizeBytes: 9, sha256: sha } }));
    await expect(build().getRunResult('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
