/**
 * TASK-950 (decision 2, fast win) — the exposure plane stamps the acting clinician onto the run
 * ROW, not only onto the audit event.
 *
 * Lane E already made a standalone machine run RESOLVE the trigger schema's identity field and
 * record it on `ResourceCreated` (`workflow-exposure.user-identity.task950.test.ts`). That leaves
 * the answer in the audit log alone: durable, but not queryable beside the run it belongs to. The
 * fast win puts the same id in `WorkflowRun._metadata`, which is.
 *
 * The interesting half of this file is the ABSENCES. `actingUserId` is null for three unrelated
 * reasons — a human caller (D-5: the caller already IS the clinician), a consultation-bound run
 * (OD-5: identity is fixed at `open` and read from the row), and a schema that declares no
 * identity field at all — and none of them is a fact about the run. So all three must produce an
 * OMITTED `metaData`, never `{ actingUserId: null }`: a stored null claims the question was asked
 * and answered "nobody", which is true of none of the three.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';

const TENANT = 'tenant-1';
const SERVICE_ACCOUNT_ID = 'svc-account-1';
const RESOLVED_USER = '70000000-0000-0000-0000-0000000009e5';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const mockConfigService = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertMeterQuota: vi.fn() };
const mockConsultationService = { getById: vi.fn() };
const resolveOrProvision = vi.fn();
const mockUserIdentity = { resolveOrProvision };

/** A compiled `core` graph whose trigger carries whatever context-schema block the case needs. */
const compiledWith = (triggerContextSchema?: Record<string, unknown>) => ({
  formatVersion: 1,
  stages: [
    {
      stageIndex: 0,
      nodes: [
        {
          nodeId: 'n0',
          type: 'core.trigger',
          activity: 'interpreter.core.trigger',
          config: triggerContextSchema ? { contextSchema: triggerContextSchema } : {},
        },
        { nodeId: 'n1', type: 'core.agent', activity: 'interpreter.core.agent', config: {} },
        { nodeId: 'n2', type: 'core.output', activity: 'interpreter.core.output', config: {} },
      ],
    },
  ],
  gates: [],
});

/** What the compiler freezes onto the trigger: the derived payload schema, plus the D-3 marker. */
const withMarker = (marker?: unknown) => ({
  contextSchemaId: 'schema-1',
  versionNumber: 3,
  resolved: { type: 'object', properties: { context: { type: 'object' } }, additionalProperties: false },
  ...(marker === undefined ? {} : { userIdentity: marker }),
});

const definition = (compiledConfig: unknown) => ({
  id: 'def-1',
  tenantId: TENANT,
  slug: 'triage_flow',
  name: 'Triage Flow',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  compiledConfig,
});

/** CLS as the guard leaves it: a machine lives on `serviceAccount`, a human on `user`. */
function principal(kind: 'machine' | 'human'): void {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'serviceAccount') return kind === 'machine' ? { id: SERVICE_ACCOUNT_ID } : null;
    if (key === 'user') return kind === 'human' ? { id: 'user-7' } : null;
    return undefined;
  });
}

function build(): WorkflowExposureService {
  return new WorkflowExposureService(
    mockWorkflowDefinitionRepository as never,
    mockHarnessGateway as never,
    mockWorkflowRunService as never,
    mockConfigService as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockS3Service as never,
    mockRedisCache as never,
    mockEntitlements as never,
    mockConsultationService as never,
    undefined, // webhookSecretRepository
    undefined, // secretsService
    undefined, // tenantSettings
    mockUserIdentity as never,
  );
}

/** What the exposure plane asked the read model to record for this run. */
const runStarted = () => mockWorkflowRunService.recordRunStarted.mock.calls.at(-1)?.[0] as Record<string, unknown>;

const IDENTITY_MARKER = { kindKey: 'context', field: 'consultant_id' };
const INPUT = { input: { context: { consultant_id: 'DR-4471' } } };

beforeEach(() => {
  vi.clearAllMocks();
  principal('machine');
  mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
  mockRedisCache.get.mockResolvedValue(null);
  mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
  mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
  mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('no run'));
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'run-1', workflowId: 'w', temporalRunId: 't', status: 'started' });
  mockConsultationService.getById.mockResolvedValue({ id: 'consult-1', tenantId: TENANT, patientId: 'patient-9', doctorId: 'doc-3' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith(withMarker(IDENTITY_MARKER))));
  resolveOrProvision.mockResolvedValue({ userId: RESOLVED_USER, provisioned: true });
});

describe('TASK-950 — actingUserId reaches the run row’s _metadata', () => {
  it('stamps the resolved clinician for a STANDALONE machine run', async () => {
    await build().invoke('triage_flow', INPUT, {});

    expect(runStarted()).toMatchObject({ metaData: { actingUserId: RESOLVED_USER } });
  });

  it('records it BESIDE the audit event, not instead of it — both channels carry the same id', async () => {
    await build().invoke('triage_flow', INPUT, {});

    const event = mockEventEmitter.emit.mock.calls
      .map((call) => call[1] as { data?: Record<string, unknown> })
      .find((payload) => payload?.data?.action === 'invoke')?.data;
    expect(event).toMatchObject({ actingUserId: RESOLVED_USER });
    expect(runStarted()).toMatchObject({ metaData: { actingUserId: RESOLVED_USER } });
  });

  it('omits metaData for a HUMAN caller — the caller already IS the clinician (D-5)', async () => {
    principal('human');

    await build().invoke('triage_flow', INPUT, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(runStarted().metaData).toBeUndefined();
  });

  it('omits metaData when the frozen schema declares no identity field', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith(withMarker())));

    await build().invoke('triage_flow', INPUT, {});

    expect(runStarted().metaData).toBeUndefined();
  });

  it('omits metaData when the marker is declared but the request sends no value', async () => {
    await build().invoke('triage_flow', { input: { context: {} } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(runStarted().metaData).toBeUndefined();
  });

  it('omits metaData on a CONSULTATION-BOUND run — identity is fixed at open, never re-decided here (OD-5)', async () => {
    await build().invoke('triage_flow', INPUT, { consultationId: 'consult-1' });

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(runStarted().metaData).toBeUndefined();
  });
});
