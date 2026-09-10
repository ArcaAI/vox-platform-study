/**
 * TASK-950 §C5 — a STANDALONE workflow run resolves the trigger schema's USER IDENTITY for a
 * machine caller (TDD tests 29 and 30).
 *
 * Two planes share this method and they are deliberately NOT symmetric:
 *
 *  · the UNBOUND plane (`POST /workflows/:slug/runs`) has no clinical subject of its own, so a
 *    machine caller's staff identifier is what names the acting clinician — resolved (or
 *    provisioned) here, before the run is dispatched or billed;
 *  · the CONSULTATION-BOUND plane fixes identity at `open` and reads it from the row. OD-5 says
 *    an identity field arriving on a bound run is ordinary content and is IGNORED — re-deciding
 *    it per run is exactly how one consultation ends up with two clinicians.
 *
 * Also pinned here, because it was WRONG before this ticket and nothing else would catch it: the
 * `ResourceCreated` event for a service-account invoke recorded `principalType: 'user'`. That is
 * the one principal class this plane cannot have — `requestUserId` is null for a machine — so the
 * event named a person who was never in the request.
 *
 * ## The subject channel, and why it is not used here
 *
 * `startWorkflowRun` receives NO subject for a standalone run, resolved identity or not.
 * `StartWorkflowRunSubject` requires `consultationId`
 * (`services/consultation/harness/harness-gateway.service.ts:244-248`) and so does the
 * dispatcher's own `RunSubject` (`apps/harness/src/harness/temporal/interpreter/models.py:174`,
 * `extra="forbid"`), so a subject carrying only `userId` is a 422 from the harness — it would
 * break every standalone run rather than attribute one. The assertion below pins that ABSENCE on
 * purpose: when both of those admit a consultation-less subject, this test is the one that has to
 * change, deliberately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
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

function build(identity: unknown = mockUserIdentity): WorkflowExposureService {
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
    undefined, // tenantSettings — absent ⇒ the env-read fallback, which `mockConfigService` answers
    identity as never,
  );
}

/** The `ResourceCreated` payload this invoke emitted. */
const invokeEvent = () =>
  mockEventEmitter.emit.mock.calls
    .map((call) => call[1] as { data?: Record<string, unknown> })
    .find((payload) => payload?.data?.action === 'invoke')?.data as Record<string, unknown>;

const dispatched = () => mockHarnessGateway.startWorkflowRun.mock.calls.at(-1)?.[0] as Record<string, unknown>;

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
  resolveOrProvision.mockResolvedValue({ userId: RESOLVED_USER, provisioned: true });
});

describe('a STANDALONE machine run resolves the trigger schema’s identity field', () => {
  it('calls the resolver with the pinned input, naming the plane, the field and the actor', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(resolveOrProvision).toHaveBeenCalledTimes(1);
    expect(resolveOrProvision).toHaveBeenCalledWith({
      tenantId: TENANT,
      staffId: 'DR-4471',
      // OD-8 — an unbound run names no department; the resolver falls to the tenant setting.
      departmentId: null,
      provenance: { plane: 'workflow-run', kindKey: 'context', field: 'consultant_id', serviceAccountId: SERVICE_ACCOUNT_ID },
    });
  });

  it('records the resolved clinician on the invoke event as `actingUserId`', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(invokeEvent()).toMatchObject({ actingUserId: RESOLVED_USER });
  });

  it('names the SERVICE ACCOUNT as the principal — never `user`, which this plane cannot have', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(invokeEvent()).toMatchObject({ principalType: 'serviceAccount', serviceAccountId: SERVICE_ACCOUNT_ID, apiKeyId: null });
  });

  it('still dispatches the run, forwarding the caller’s input verbatim', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    const response = await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(response.status).toBe('started');
    expect(dispatched().payload).toEqual({ context: { consultant_id: 'DR-4471' } });
    // See the file header: the subject channel requires a consultation on BOTH sides of the wire,
    // so a standalone run still dispatches without one. Change this only with those two.
    expect(dispatched().subject).toBeUndefined();
  });

  it('leaves the reserved-key rejection exactly as it was — an identity field is a normal property', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    // `userId` IS reserved; `consultant_id` is not, and marking a field as identity must never
    // promote it into that set — the schema property and the run-identity channel are different
    // things that happen to describe the same person.
    await expect(build().invoke('triage_flow', { input: { userId: 'VICTIM' } }, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('everything that legitimately resolves NOTHING', () => {
  it('a CONSULTATION-BOUND run — identity is fixed at open (OD-5)', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, { consultationId: 'consult-1' });

    expect(resolveOrProvision).not.toHaveBeenCalled();
    // The subject is the one the SERVER resolved from the path, untouched by the field.
    expect(dispatched().subject).toEqual({ consultationId: 'consult-1', externalPatientId: 'patient-9', userId: undefined });
    expect(invokeEvent()).toMatchObject({ actingUserId: null, consultationId: 'consult-1' });
  });

  it('a HUMAN caller (D-5), whose event still says `user`', async () => {
    principal('human');
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(invokeEvent()).toMatchObject({ principalType: 'user', serviceAccountId: null, actingUserId: null });
  });

  it('an API-KEY caller still reads as `apiKey` — the pre-existing branch is unchanged', async () => {
    principal('human');
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith(withMarker())));

    await build().invoke('triage_flow', { input: {} }, { apiKeyId: 'key-3' });

    expect(invokeEvent()).toMatchObject({ principalType: 'apiKey', apiKeyId: 'key-3' });
  });

  it('a trigger schema with no marker', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith(withMarker())));

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(invokeEvent()).toMatchObject({ actingUserId: null });
  });

  it('a trigger that binds no context schema at all', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith()));

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('a declared marker whose field this run did not supply (D-2)', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await build().invoke('triage_flow', { input: { context: { chief_complaint: 'headache' } } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('a MALFORMED marker reads as absent rather than 500ing an already-published workflow', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition(compiledWith(withMarker({ field: 'consultant_id' }))));

    await build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {});

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(1);
  });
});

describe('ordering: before the run row and the dispatch', () => {
  it('a resolver refusal leaves NO run row and dispatches nothing', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );
    resolveOrProvision.mockRejectedValue(new NotFoundException({ message: 'no such staff id', code: 'USER_IDENTITY_UNKNOWN' }));

    await expect(build().invoke('triage_flow', { input: { context: { consultant_id: 'DR-NOBODY' } } }, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('an UNWIRED resolver is a named 503, never a silent dispatch with no clinician', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
      definition(compiledWith(withMarker({ kindKey: 'context', field: 'consultant_id' }))),
    );

    await expect(build(undefined).invoke('triage_flow', { input: { context: { consultant_id: 'DR-4471' } } }, {})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});
