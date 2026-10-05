/**
 * TASK-1038 OD-35 — workflow run reads on the exposure plane are bound to the STARTING principal.
 *
 * `invoke` records who started the run (`_metadata.startedBy`: the API key, the service account,
 * or the human of a JWT) and scopes an `Idempotency-Key` to that principal. Every business-plane
 * read — `getRunStatus` (which the SSE stream, the socket and the stream-ticket mint all go
 * through), `getRunResult` and `cancelRun` — answers a run another principal started with the
 * SAME 404 as an unknown run, unless the reader holds `workflow:run:read-all` (machine) or is a
 * SUPER_ADMIN / TENANT_ADMIN of the working tenant (human).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { deterministicRunId } from '../deterministic-run-id';
import { RunPrincipalAccessService, principalScopedIdempotencyKey, type RunPrincipal } from '../../workflow-run/run-principal-access';

const TENANT = 'tenant-1';
const SLUG = 'discharge_summary';
const RUN = 'run-1';

let store: Record<string, unknown> = {};
let roleRows: Array<{ tenantId: string; Roles: Array<{ name: string }> }> = [];
const mockClsService = { get: vi.fn((key: string) => store[key]), set: vi.fn() };
const mockRoleAssignments = { findAll: vi.fn(async () => roleRows) };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = {
  getRun: vi.fn(),
  getRunForReader: vi.fn(),
  recordRunStarted: vi.fn(),
  recordRunFinished: vi.fn(),
  getRunRequestBodyHash: vi.fn(),
};
const mockConfigService = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };

const definition = () => ({
  id: 'def-1',
  tenantId: TENANT,
  slug: SLUG,
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  compiledConfig: {
    formatVersion: 1,
    stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n0', type: 'core.agent', activity: 'interpreter.core_agent', config: {} }] }],
    gates: [],
  },
});

function build() {
  const positional: unknown[] = [
    mockWorkflowDefinitionRepository,
    mockHarnessGateway,
    mockWorkflowRunService,
    mockConfigService,
    mockEventEmitter,
    mockClsService,
    mockS3Service,
    mockRedisCache,
    undefined /* entitlements */,
    undefined /* consultation */,
    undefined /* webhook secrets */,
    undefined /* secrets */,
    undefined /* tenant settings */,
    undefined /* user identity */,
    undefined /* billing */,
    undefined /* context schemas */,
    undefined /* effective trigger schema */,
    undefined /* blob storage */,
    new RunPrincipalAccessService(mockClsService as never, mockRoleAssignments as never),
  ];
  return new (WorkflowExposureService as unknown as new (...args: unknown[]) => WorkflowExposureService)(...positional);
}

const KEY_A: RunPrincipal = { type: 'apiKey', id: 'key-A' };
const asApiKey = (id: string, scopes: string[] = ['workflow:run:read']) => {
  store = { tenantId: TENANT, user: { id: 'human-1', tenantId: TENANT }, apiKey: { id, scopes } };
};
const asServiceAccount = (id: string, scopes: string[] = ['svc:workflow:run:read']) => {
  store = { tenantId: TENANT, serviceAccount: { id, scopes, roles: [], workingTenantId: TENANT } };
};
const asHuman = (id: string, tenantRoles: string[] = []) => {
  store = { tenantId: TENANT, user: { id, tenantId: TENANT } };
  roleRows = [{ tenantId: TENANT, Roles: tenantRoles.map((name) => ({ name })) }];
};

const row = (startedBy: RunPrincipal | null, overrides: Record<string, unknown> = {}) => ({
  run: {
    runId: RUN,
    tenantId: TENANT,
    workflowSlug: SLUG,
    workflowVersionId: 'def-1',
    workflowVersionNumber: 1,
    sessionId: `workflow-interpreter-${RUN}`,
    status: 'COMPLETED',
    startedAt: '2026-10-05T00:00:00.000Z',
    endedAt: '2026-10-05T00:01:00.000Z',
    resultRef: { kind: 'inline', value: { note: 'SOAP' } },
    ...overrides,
  },
  startedBy,
});

/** The exact refusal an unknown run gets — the body a foreign principal's run must also get. */
const UNKNOWN_RUN_MESSAGE = `WorkflowRun ${RUN} not found`;

async function expectUnknownRun(attempt: Promise<unknown>): Promise<void> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NotFoundException);
  expect((err as NotFoundException).getResponse()).toEqual(new NotFoundException(UNKNOWN_RUN_MESSAGE).getResponse());
}

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  roleRows = [];
  mockRedisCache.get.mockResolvedValue(null);
  mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
  mockWorkflowRunService.recordRunFinished.mockResolvedValue(undefined);
  mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('no run'));
  mockWorkflowRunService.getRunRequestBodyHash.mockResolvedValue(null);
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'x', workflowId: 'w', temporalRunId: 't', status: 'started' });
  mockHarnessGateway.getWorkflowRun.mockResolvedValue({ runId: RUN, status: 'SUCCEEDED', stages: [], startedAt: null, endedAt: null });
  mockHarnessGateway.cancelWorkflowRun.mockResolvedValue({ status: 'cancelled' });
});

describe('OD-35 — invoke records the starting principal', () => {
  it('an API key start is stamped with the KEY', async () => {
    asApiKey('key-A');
    await build().invoke(SLUG, { input: {} }, { apiKeyId: 'key-A' });
    const meta = (mockWorkflowRunService.recordRunStarted.mock.calls[0][0] as { metaData?: Record<string, unknown> }).metaData;
    expect(meta?.startedBy).toEqual(KEY_A);
  });

  it('a service-account start is stamped with the account; a human start with the user', async () => {
    asServiceAccount('sa-1');
    await build().invoke(SLUG, { input: {} }, {});
    asHuman('doctor-1');
    await build().invoke(SLUG, { input: {} }, {});
    const stamps = mockWorkflowRunService.recordRunStarted.mock.calls.map((c) => (c[0] as { metaData?: Record<string, unknown> }).metaData?.startedBy);
    expect(stamps).toEqual([
      { type: 'serviceAccount', id: 'sa-1' },
      { type: 'user', id: 'doctor-1' },
    ]);
  });

  it('the same Idempotency-Key from two principals derives two different runs — B never joins A', async () => {
    asApiKey('key-A');
    const a = await build().invoke(SLUG, { input: {} }, { idempotencyKey: 'k-1', apiKeyId: 'key-A' });
    asApiKey('key-B');
    const b = await build().invoke(SLUG, { input: {} }, { idempotencyKey: 'k-1', apiKeyId: 'key-B' });
    expect(a.runId).toBe(deterministicRunId(TENANT, SLUG, principalScopedIdempotencyKey(KEY_A, 'k-1')));
    expect(b.runId).toBe(deterministicRunId(TENANT, SLUG, principalScopedIdempotencyKey({ type: 'apiKey', id: 'key-B' }, 'k-1')));
    expect(a.runId).not.toBe(b.runId);
    // …and the Redis fast-path records are per principal too.
    const cacheKeys = mockRedisCache.setex.mock.calls.map((c) => c[0] as string);
    expect(new Set(cacheKeys).size).toBe(2);
  });
});

describe('OD-35 — getRunStatus (also the SSE, socket and stream-ticket ownership read)', () => {
  it('API key A reads the run it started', async () => {
    asApiKey('key-A');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expect(build().getRunStatus(SLUG, RUN)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('API key B gets the unknown-run 404 for A’s run, and the harness is never asked', async () => {
    asApiKey('key-B');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expectUnknownRun(build().getRunStatus(SLUG, RUN));
    expect(mockHarnessGateway.getWorkflowRun).not.toHaveBeenCalled();
  });

  it('a service account gets the 404 for a run an API key started', async () => {
    asServiceAccount('sa-1');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expectUnknownRun(build().getRunStatus(SLUG, RUN));
  });

  it('a credential holding workflow:run:read-all reads every run of the tenant', async () => {
    asApiKey('key-B', ['workflow:run:read', 'workflow:run:read-all']);
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expect(build().getRunStatus(SLUG, RUN)).resolves.toMatchObject({ status: 'COMPLETED' });
    asServiceAccount('sa-1', ['svc:workflow:run:read', 'svc:workflow:run:read-all']);
    await expect(build().getRunStatus(SLUG, RUN)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('a doctor gets the 404 for a run it did not start; a tenant admin reads it', async () => {
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    asHuman('doctor-1', ['DOCTOR']);
    await expectUnknownRun(build().getRunStatus(SLUG, RUN));
    asHuman('admin-1', ['TENANT_ADMIN']);
    await expect(build().getRunStatus(SLUG, RUN)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('a run with no recorded starter (pre-OD-35, webhook) is tenant-admin-only', async () => {
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(null));
    asApiKey('key-A');
    await expectUnknownRun(build().getRunStatus(SLUG, RUN));
    asHuman('admin-1', ['TENANT_ADMIN']);
    await expect(build().getRunStatus(SLUG, RUN)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('an unknown run is the same 404', async () => {
    asApiKey('key-A');
    mockWorkflowRunService.getRunForReader.mockRejectedValue(new NotFoundException(UNKNOWN_RUN_MESSAGE));
    await expectUnknownRun(build().getRunStatus(SLUG, RUN));
  });
});

describe('OD-35 — getRunResult and cancelRun', () => {
  it('B cannot read A’s result: the unknown-run 404, and nothing is audited as read', async () => {
    asApiKey('key-B');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expectUnknownRun(build().getRunResult(SLUG, RUN));
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('A reads its own result', async () => {
    asApiKey('key-A');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A));
    await expect(build().getRunResult(SLUG, RUN)).resolves.toMatchObject({ kind: 'inline', value: { note: 'SOAP' } });
  });

  it('B cannot cancel A’s run: the unknown-run 404, and no cancel signal is sent', async () => {
    asApiKey('key-B');
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A, { status: 'RUNNING' }));
    await expectUnknownRun(build().cancelRun(SLUG, RUN));
    expect(mockHarnessGateway.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('A cancels its own run; a tenant admin may cancel any', async () => {
    mockWorkflowRunService.getRunForReader.mockResolvedValue(row(KEY_A, { status: 'RUNNING' }));
    asApiKey('key-A');
    await build().cancelRun(SLUG, RUN);
    asHuman('admin-1', ['TENANT_ADMIN']);
    await build().cancelRun(SLUG, RUN);
    expect(mockHarnessGateway.cancelWorkflowRun).toHaveBeenCalledTimes(2);
  });
});

describe('OD-35 — wiring (the binding is @Optional() for fixtures, so production must provide it)', () => {
  it('WorkflowRunServiceModule provides and exports RunPrincipalAccessService; the exposure and dispatch modules import it', async () => {
    const { WorkflowRunServiceModule } = await import('../../workflow-run/workflow-run.service.module');
    const { WorkflowExposureServiceModule } = await import('../workflow-exposure.service.module');
    const { ConsultationWorkflowDispatchServiceModule } = await import('../../consultation/workflow-dispatch/consultation-workflow-dispatch.service.module');
    expect(Reflect.getMetadata('providers', WorkflowRunServiceModule)).toContain(RunPrincipalAccessService);
    expect(Reflect.getMetadata('exports', WorkflowRunServiceModule)).toContain(RunPrincipalAccessService);
    expect(Reflect.getMetadata('imports', WorkflowExposureServiceModule)).toContain(WorkflowRunServiceModule);
    expect(Reflect.getMetadata('imports', ConsultationWorkflowDispatchServiceModule)).toContain(WorkflowRunServiceModule);
  });
});
