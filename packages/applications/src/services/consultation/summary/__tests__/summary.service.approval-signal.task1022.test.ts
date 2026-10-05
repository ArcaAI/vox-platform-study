/**
 * TASK-1022 (L-POLISH R2) — the `harness-doc` approval signal is sent only where `harness-doc` exists.
 *
 * Since TASK-1022 (`9f4c5bd34`) a consultation governed by a tenant workflow never starts
 * `HarnessDocWorkflow`: its loop is cancelled, not ended. Every sign-off of such a consultation still
 * posted `/internal/workflows/{consultationId}/signal/approve`, and the harness answered with an
 * unhandled 500 (`RPCError: workflow not found for ID: harness-doc-<id>`), logged as
 * "Harness approval signal failed". The governed sign-off is released through the governing run's
 * review (TASK-972 Lane 3) — untouched here — and the `harness-doc` signal is skipped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { wireSessionApproval } from './session-approval.fixture';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({
        ...props,
        changedBy: props.attestedBy,
        id: 'signed-1',
        changeReason: 'approved',
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
      })),
    },
  };
});

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';
const DOCTOR = 'doctor-1';
const RUN = 'run-42';
const SLUG = 'arcaai-consultation';

const governingMarker = {
  governingEngine: { engine: 'tenant-workflow', workflowRunId: RUN, workflowDefinitionSlug: SLUG, decidedAt: '2026-09-15T00:00:00.000Z' },
};

const cls = () => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : null)),
  set: vi.fn(),
});

const consultationWith = (metadata: unknown) =>
  new ConsultationEntity({
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    departmentId: null,
    doctorId: DOCTOR,
    parentConsultationId: null,
    appointmentDate: new Date('2026-01-01'),
    metadata,
    degradedReasons: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    status: ConsultationStatus.STOPPED,
    version: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

const makeMocks = (metadata: unknown = governingMarker) => ({
  contextItemRepository: {
    findById: vi.fn().mockResolvedValue({
      id: CONTEXT_ITEM,
      tenantId: TENANT,
      consultationId: CONSULTATION,
      isFinalSummary: true,
      content: 'SIGNED NOTE BODY',
      currentVersionNumber: 1,
      version: 1,
    }),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    encryptContentIntoEntity: vi.fn(),
  },
  consultationRepository: {
    findById: vi.fn().mockResolvedValue(consultationWith(metadata)),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  },
  summaryMetaRepository: { findByContextItem: vi.fn().mockResolvedValue(null) },
  namedEntityRepository: { create: vi.fn() },
  httpService: { axiosRef: { post: vi.fn() } },
  configService: { get: vi.fn(() => undefined) },
  eventEmitter: { emit: vi.fn() },
  contextItemVersionRepository: { create: vi.fn(async (e: unknown) => e), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) },
  promptAssembly: { assemble: vi.fn() },
  harnessAudit: { append: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  harnessGateway: { signalApproval: vi.fn().mockResolvedValue({}) },
  workflowExposure: { decideReview: vi.fn().mockResolvedValue({ runId: RUN, nodeId: 'n_review', decision: 'approved', signaled: true }) },
  workflowDefinitionRepository: {
    findPublishedBySlug: vi.fn().mockResolvedValue({
      graph: {
        nodes: [
          { id: 'n_agent', type: 'core.agent' },
          { id: 'n_review', type: 'core.humanReview' },
          { id: 'n_output', type: 'core.output' },
        ],
      },
    }),
  },
});

type Mocks = ReturnType<typeof makeMocks>;

const build = (m: Mocks, overrides: { workflowExposure?: unknown; workflowDefinitionRepository?: unknown } = {}) => {
  const args: unknown[] = new Array(37).fill(undefined);
  args[0] = m.contextItemRepository;
  args[1] = m.consultationRepository;
  args[2] = m.summaryMetaRepository;
  args[3] = m.namedEntityRepository;
  args[4] = m.httpService;
  args[5] = m.configService;
  args[6] = m.eventEmitter;
  args[7] = cls();
  args[8] = m.contextItemVersionRepository;
  args[9] = m.promptAssembly;
  args[12] = m.harnessAudit;
  args[13] = m.harnessGateway;
  args[35] = 'workflowExposure' in overrides ? overrides.workflowExposure : m.workflowExposure;
  args[36] = 'workflowDefinitionRepository' in overrides ? overrides.workflowDefinitionRepository : m.workflowDefinitionRepository;
  const service = new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
  // approveSummary delegates to the session approve; wire the real one behind ModuleRef.
  wireSessionApproval(service);
  return service;
};

describe('approveSummary — the harness-doc approval signal targets only the default engine (TASK-1022 R2)', () => {
  let m: Mocks;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GOVERNED: no harness-doc signal; the governing run`s review is still released', async () => {
    m = makeMocks(governingMarker);
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.harnessGateway.signalApproval).not.toHaveBeenCalled();
    expect(m.workflowExposure.decideReview).toHaveBeenCalledWith(SLUG, RUN, 'n_review', { decision: 'approved' });
  });

  it('DEFAULT engine (no marker): the harness-doc signal is sent, and no governing review is touched', async () => {
    m = makeMocks(null);
    const service = build(m);

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(m.harnessGateway.signalApproval).toHaveBeenCalledTimes(1);
    expect(m.harnessGateway.signalApproval).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({ tenantId: TENANT, clinicianId: DOCTOR, attestationHash: expect.any(String) }),
    );
    expect(m.workflowExposure.decideReview).not.toHaveBeenCalled();
  });

  it('a MALFORMED marker reads as the default engine — the signal is still sent', async () => {
    m = makeMocks({ governingEngine: { engine: 'tenant-workflow' } });
    const service = build(m);

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(m.harnessGateway.signalApproval).toHaveBeenCalledTimes(1);
  });
});
