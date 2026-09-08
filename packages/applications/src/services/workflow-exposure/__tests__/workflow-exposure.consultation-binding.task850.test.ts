/**
 * lane A — a consultation workflow becomes invocable WITHOUT reopening C-8.
 *
 * The business requirement (owner, 2026-09-01) is that a tenant publishes a consultation
 * workflow and their developer runs it from an application. `EXPOSURE_ALLOWED_PALETTES` refuses
 * that outright, and own brief forbids both the easy answers: lifting the allow-list
 * reopens C-8 verbatim, and refusing the requirement fails the ticket.
 *
 * The resolution is 's invariant, generalised from a session-bound entry point to an
 * invocation-bound one:
 *
 *   > consultation identity comes from the URL and is re-resolved against the caller's tenant —
 *   > never from a caller-composed payload.
 *
 * So the boundary is not LIFTED, it is SPLIT in two:
 *
 *   * the UNBOUND plane (`POST /workflows/:slug/runs`) keeps `EXPOSURE_ALLOWED_PALETTES`
 *     unchanged — `{'summarization'}`. A consultation graph is refused there exactly as before;
 *   * the BOUND plane (`POST /consultations/:consultationId/workflows/:slug/runs`) uses
 *     `CONSULTATION_BOUND_ALLOWED_PALETTES`, and is reachable ONLY with a binding the service
 *     itself produced by re-resolving the path parameter through a tenant-scoped read.
 *
 * These tests pin BOTH sets and prove the wider one is unreachable without the binding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { CONSULTATION_BOUND_ALLOWED_PALETTES, EXPOSURE_ALLOWED_PALETTES } from '../exposure-palette-policy';

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

type CompiledNodeSpec = string | { type: string; config: Record<string, unknown> };
const compiledWith = (...specs: CompiledNodeSpec[]) => ({
  formatVersion: 1,
  stages: [
    {
      stageIndex: 0,
      nodes: specs.map((spec, i) => {
        const { type, config } = typeof spec === 'string' ? { type: spec, config: {} } : spec;
        return { nodeId: `n${i}`, type, activity: `interpreter.${type}`, config };
      }),
    },
  ],
  gates: [],
});
const action = (actionKey: string) => ({ type: 'core.action', config: { actionKey } });
const liveAgent = (slug: string) => ({ type: 'core.agent', config: { agentRef: { slug }, execution: { lane: 'realtime' } } });

const SUMMARIZATION_CONFIG = compiledWith('core.trigger', 'core.agent', 'core.output');
/** The C-8 chain: `consultation.persistDraft` -> `persist_draft` -> real ContextItem rows. */
const CONSULTATION_CONFIG = compiledWith('core.trigger', action('consultation.consentGate'), 'core.agent', action('consultation.persistDraft'), 'core.output');
/** Every node is `lane: 'realtime'`, which the DURABLE interpreter skips — an invoke would do nothing. */
const REALTIME_ONLY_CONFIG = compiledWith('core.trigger', liveAgent('realtime-transcription'), liveAgent('general-medicine-summarization'), 'core.output');

const definition = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'def-1',
  tenantId: 'tenant-1',
  slug: overrides.slug ?? 'consult_flow',
  name: overrides.name ?? 'Consultation Flow',
  description: null,
  paletteKey: overrides.paletteKey ?? 'core',
  versionNumber: 1,
  compiledConfig: overrides.compiledConfig ?? CONSULTATION_CONFIG,
});

function build() {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
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
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
  mockRedisCache.get.mockResolvedValue(null);
  mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
  mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
  mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('no run'));
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'run-1', workflowId: 'w', temporalRunId: 't', status: 'started' });
  mockConsultationService.getById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', patientId: 'patient-9', doctorId: 'doc-3' });
});

describe('the two palette sets are pinned, and only one is wide', () => {
  it('leaves the unbound set exactly as C-8 left it', () => {
    // TASK-864 widened both sets by `core`, whose real boundary is the CLASS-BASED rule
    // (`clinicalWriteViolation`) — see `workflow-exposure.core-protocols.task864.test.ts`.
    expect([...EXPOSURE_ALLOWED_PALETTES].sort()).toEqual(['core']);
  });

  it('admits consultation ONLY on the consultation-bound set', () => {
    expect([...CONSULTATION_BOUND_ALLOWED_PALETTES].sort()).toEqual(['core']);
    expect(EXPOSURE_ALLOWED_PALETTES.has('consultation')).toBe(false);
  });
});

describe('the unbound plane is unchanged (C-8 stays closed)', () => {
  it('still refuses a consultation graph with 404 and no dispatch', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    const service = build();

    await expect(service.invoke('consult_flow', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('the bound plane runs a consultation workflow for real', () => {
  it('re-resolves the path consultation, freezes it into `subject`, and dispatches', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    const service = build();

    const response = await service.invoke('consult_flow', { input: { note: 'follow-up' } }, { consultationId: 'consult-1' });

    expect(response.status).toBe('started');
    // The binding was RE-RESOLVED, not trusted: the service read the row itself.
    expect(mockConsultationService.getById).toHaveBeenCalledWith('consult-1');

    const dispatched = mockHarnessGateway.startWorkflowRun.mock.calls[0][0];
    expect(dispatched.subject).toEqual({ consultationId: 'consult-1', externalPatientId: 'patient-9', userId: undefined });
    // The caller's own business input still reaches the run.
    expect(dispatched.payload).toEqual({ note: 'follow-up' });
  });

  it('records the run against the caller tenant before dispatching', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    const service = build();

    await service.invoke('consult_flow', { input: {} }, { consultationId: 'consult-1' });

    expect(mockWorkflowRunService.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', trigger: 'api invoke' }));
  });
});

describe('THE REFUSAL: a caller cannot name someone else’s consultation', () => {
  it('404s when the path consultation is not the caller tenant’s (the row read returns nothing)', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    mockConsultationService.getById.mockResolvedValue(null); // tenant-scoped read: a foreign id is simply absent
    const service = build();

    await expect(service.invoke('consult_flow', { input: {} }, { consultationId: 'someone-elses' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
  });

  it('404s when the tenant read itself rejects the id (getById’s assertEqualTenants throws)', async () => {
    // `ConsultationService.getById` runs `assertEqualTenants` and fails closed for a row that
    // somehow reached it from another tenant. The exposure plane must surface that as its own
    // 404 rather than letting a foreign exception shape leak — and must not dispatch.
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    mockConsultationService.getById.mockRejectedValue(new NotFoundException('Resource not found'));
    const service = build();

    await expect(service.invoke('consult_flow', { input: {} }, { consultationId: 'consult-x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('400s when the caller tries to smuggle identity through `input` — never a silent drop', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition({ paletteKey: 'core', compiledConfig: SUMMARIZATION_CONFIG }));
    const service = build();

    // A silent drop would let the caller believe it addressed a consultation it did not.
    await expect(service.invoke('consult_flow', { input: { consultationId: 'VICTIM', text: 'x' } }, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('400s on a smuggled identity key even when a legitimate binding is present', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
    const service = build();

    await expect(service.invoke('consult_flow', { input: { consultationId: 'VICTIM' } }, { consultationId: 'consult-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('refuses a realtime-only graph on the bound plane — the durable interpreter would do nothing', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition({ compiledConfig: REALTIME_ONLY_CONFIG }));
    const service = build();

    await expect(service.invoke('consult_flow', { input: {} }, { consultationId: 'consult-1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('list() and the gate keep agreeing', () => {
  it('omits consultation definitions from the unbound catalogue', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition({ slug: 'summary_ok', paletteKey: 'core', compiledConfig: SUMMARIZATION_CONFIG }),
      definition({ slug: 'consult_flow' }),
    ]);
    const service = build();

    expect((await service.list()).data.map((row) => row.slug)).toEqual(['summary_ok']);
  });

  it('includes them in the consultation-bound catalogue', async () => {
    mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
      definition({ slug: 'summary_ok', paletteKey: 'core', compiledConfig: SUMMARIZATION_CONFIG }),
      definition({ slug: 'consult_flow' }),
      definition({ slug: 'realtime_only', compiledConfig: REALTIME_ONLY_CONFIG }),
    ]);
    const service = build();

    const result = await service.list({ consultationBound: true });
    expect(result.data.map((row) => row.slug).sort()).toEqual(['consult_flow', 'summary_ok']);
  });
});
