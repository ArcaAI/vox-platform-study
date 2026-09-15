/**
 * TASK-972 Lane 3 — TASK-933 defect H3-6: the sign-off reaches the run that is actually governing.
 *
 * `HarnessGatewayService.signalApproval` posts to `/internal/workflows/{consultationId}/signal/approve`,
 * documented as targeting that consultation's `harness-doc-<consultationId>` execution —
 * **Substrate A**. A consultation governed by a tenant workflow runs on **Substrate B**
 * (`WorkflowInterpreter`), where that execution does not exist. The POST fails, the failure is
 * swallowed (it is best-effort by design), and the run stays parked on its review gate forever.
 *
 * The fix releases the governing run's review child through the EXISTING decide path
 * (`WorkflowExposureService.decideReview`) — no new harness endpoint, no Python change, and
 * therefore no replay exposure.
 *
 * **Best-effort and idempotent by construction.** Under OD-2 the external consumer still
 * auto-approves the gate before the clinician ever signs, so *pointer absent*, *gate already
 * closed* and *run already completed* are all NORMAL outcomes — each is logged and the sign-off
 * continues. A gate that cannot be released must never fail a signature.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SummaryService } from '../summary.service';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ContextItemVersionFactory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CreateSignedNoteVersion: vi.fn((props: any) => ({ ...props, id: 'signed-1', changeReason: 'approved', createdAt: new Date('2026-06-15T00:00:00.000Z') })),
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
    status: ConsultationStatus.PENDING_REVIEW,
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
  return new SummaryService(...(args as ConstructorParameters<typeof SummaryService>));
};

describe('approveSummary — releasing the GOVERNING run`s review (TASK-933 H3-6)', () => {
  let m: Mocks;

  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('releases the Substrate-B review child, addressed by the run the consultation names', async () => {
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.workflowExposure.decideReview).toHaveBeenCalledWith(SLUG, RUN, 'n_review', { decision: 'approved' });
    // Substrate A is still signalled — a consultation may legitimately be on either substrate,
    // and this lane ADDS a target rather than replacing one.
    expect(m.harnessGateway.signalApproval).toHaveBeenCalledTimes(1);
  });

  it('releases EVERY review node the governing graph declares', async () => {
    m.workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
      graph: { nodes: [{ id: 'n_review', type: 'core.humanReview' }, { id: 'n_review_2', type: 'core.humanReview' }] },
    });
    const service = build(m);

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(m.workflowExposure.decideReview).toHaveBeenCalledTimes(2);
    expect(m.workflowExposure.decideReview.mock.calls.map((c) => c[2])).toEqual(['n_review', 'n_review_2']);
  });

  // ── The three NORMAL outcomes (OD-2) ──────────────────────────────────────────────────────
  it('NORMAL: the pointer is absent — Substrate A governs, so there is nothing to release', async () => {
    m.consultationRepository.findById.mockResolvedValue(consultationWith(null));
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.workflowExposure.decideReview).not.toHaveBeenCalled();
    expect(m.workflowDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
  });

  it('NORMAL: the gate is already closed — the interpreter answers `signaled: false`, and the sign-off stands', async () => {
    m.workflowExposure.decideReview.mockResolvedValue({ runId: RUN, nodeId: 'n_review', decision: 'approved', signaled: false });
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
  });

  it('NORMAL: the run has already completed — the decide path 404s, and the sign-off still stands', async () => {
    m.workflowExposure.decideReview.mockRejectedValue(new NotFoundException(`Run '${RUN}' not found for workflow '${SLUG}'.`));
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.consultationRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  // ── Degraded compositions ─────────────────────────────────────────────────────────────────
  it('a malformed marker reads as ABSENT — never as a run to signal', async () => {
    m.consultationRepository.findById.mockResolvedValue(consultationWith({ governingEngine: { engine: 'tenant-workflow' } }));
    const service = build(m);

    await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(m.workflowExposure.decideReview).not.toHaveBeenCalled();
  });

  it('a graph with no review node releases nothing, and does not fail the sign-off', async () => {
    m.workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ graph: { nodes: [{ id: 'n_agent', type: 'core.agent' }] } });
    const service = build(m);

    const result = await service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 });

    expect(result.approvalStatus).toBe('APPROVED');
    expect(m.workflowExposure.decideReview).not.toHaveBeenCalled();
  });

  it('an unreadable definition never fails the sign-off', async () => {
    m.workflowDefinitionRepository.findPublishedBySlug.mockRejectedValue(new Error('db down'));
    const service = build(m);

    await expect(service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 })).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
  });

  it('signs normally when neither collaborator is wired (pre-ticket behaviour)', async () => {
    const service = build(m, { workflowExposure: undefined, workflowDefinitionRepository: undefined });

    await expect(service.approveSummary(CONTEXT_ITEM, { expectedVersion: 1 })).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
  });
});
