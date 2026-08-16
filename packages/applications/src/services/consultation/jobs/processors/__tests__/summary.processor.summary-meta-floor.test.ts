/**
 * TASK-714 — Legacy Generator Safety Floor.
 *
 * `SummaryProcessor` is the legacy (non-harness) branch of TASK-704's
 * `NoteGenerationService` seam. Before this ticket it created a `ContextItem`
 * for the generated note but wrote NO `SummaryMeta` row, which left
 * `SummaryService.approveSummary`'s `signedBeforeAssurance` guard vacuously
 * `false` for every legacy-generated note (see ticket §1/§2). These tests
 * assert the floor: a `SummaryMeta` row with `assuranceCompletedAt` set, a
 * `Consultation.status` flip to `PENDING_REVIEW`, dosage-parity flagging
 * feeding the SAME `guardrailDecisions.safety` field
 * `SummaryService.hasSafetyFlag` already reads, a groundedness call that is
 * advisory-only, and one WORM `GENERATE` event.
 *
 * This code is deleted by TASK-732 (`legacy-migration-deletion`) in the same
 * epic that retires the legacy generator — see D1 in
 * `docs/architecture/agentic-workflow-platform/design.md`. It is a capped
 * floor, not parity with the harness's full sensor suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus, HarnessAuditAction } from '@arcaai/domains';
import { SummaryProcessor } from '../summary.processor';

const CONSULTATION = {
  id: 'consult-1',
  tenantId: 'tenant-1',
  patientId: 'patient-1',
  departmentId: null as string | null,
  doctorId: 'doctor-1',
  parentConsultationId: null as string | null,
  appointmentDate: new Date('2026-01-01'),
  metadata: null,
  degradedReasons: [],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  createdBy: 'user-1',
  version: 1,
  // TASK-711 — DRAINING is the legal predecessor of the PENDING_REVIEW flip
  // `applyLegacySafetyFloor` performs (mirrors `persistDraft`'s non-early
  // branch; state-machine.md §2).
  status: ConsultationStatus.DRAINING,
};

function createProcessor(overrides: { consultation?: Record<string, unknown>; groundednessVerdict?: string; smrSummary?: string } = {}) {
  // TASK-711: the processor now calls the real ConsultationEntity.transitionTo.
  const consultation = new ConsultationEntity({ ...CONSULTATION, ...(overrides.consultation ?? {}) } as any);

  const jobService = {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  };
  const contextItemRepository = {
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'Patient reports fever. Prescribed amoxicillin 500 mg three times daily.' }]),
    findById: vi.fn(),
    create: vi.fn().mockImplementation(async (entity: any) => ({ id: 'ctx-1', content: entity.content })),
    encryptContentIntoEntity: vi.fn(),
    findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
  };
  const consultationRepository = {
    findById: vi.fn().mockResolvedValue(consultation),
    update: vi.fn().mockResolvedValue(undefined),
    updateWithVersion: vi.fn().mockResolvedValue(undefined),
  };
  const httpService = {
    axiosRef: {
      post: vi.fn().mockResolvedValue({ data: { summary: overrides.smrSummary ?? 'Prescribed amoxicillin 500 mg three times daily.' } }),
    },
  };
  const configService = { get: vi.fn(() => 'http://smr.test') };
  const jobMetrics = {
    recordJobStart: vi.fn(() => () => 1),
    recordWaitingDuration: vi.fn(),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordSmrCallDuration: vi.fn(),
  };
  const cls = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const promptResolutionService = {
    resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Summary', promptId: 'p1' }),
  };
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({
      userPrompt: 'assembled',
      systemPrompt: 'system',
      hyperparameters: {},
      responseFormat: null,
      resolvedFrom: 'tenant',
    }),
  };

  const summaryMetaRepository = {
    findByContextItem: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (entity: any) => entity),
    encryptFieldsIntoEntity: vi.fn(),
  };

  const harnessAuditService = {
    append: vi.fn().mockResolvedValue(undefined),
  };

  const groundednessTool = {
    execute: vi.fn().mockResolvedValue({ verdict: overrides.groundednessVerdict ?? 'grounded', checkedAt: new Date().toISOString() }),
  };

  const processor = new SummaryProcessor(
    jobService as any,
    contextItemRepository as any,
    consultationRepository as any,
    httpService as any,
    configService as any,
    eventEmitter as any,
    promptResolutionService as any,
    promptAssemblyService as any,
    jobMetrics as any,
    cls as any,
    undefined, // secretsService
    undefined, // namedEntityRepository
    undefined, // harnessPolicyService
    undefined, // configResolver
    undefined, // noteGenerationService — falls back to unconditional legacy generation
    summaryMetaRepository as any,
    harnessAuditService as any,
    groundednessTool as any,
  );

  return { processor, consultationRepository, summaryMetaRepository, harnessAuditService, groundednessTool, contextItemRepository };
}

const job = () =>
  ({
    id: 'bull-1',
    timestamp: Date.now(),
    data: {
      jobId: 'job-1',
      consultationId: 'consult-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      request: { options: { conversationLanguage: 'en' } },
    },
  }) as any;

describe('SummaryProcessor — TASK-714 legacy safety floor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a SummaryMeta row with assuranceCompletedAt set for the created ContextItem', async () => {
    const { processor, summaryMetaRepository } = createProcessor();

    await processor.process(job());

    expect(summaryMetaRepository.create).toHaveBeenCalledTimes(1);
    const written = summaryMetaRepository.create.mock.calls[0][0];
    expect(written.contextItemId).toBe('ctx-1');
    expect(written.assuranceCompletedAt).toBeInstanceOf(Date);
    expect(written.tenantId).toBe('tenant-1');
  });

  it('flips Consultation.status to PENDING_REVIEW', async () => {
    const { processor, consultationRepository } = createProcessor();

    await processor.process(job());

    expect(consultationRepository.updateWithVersion).toHaveBeenCalledWith(
      'consult-1',
      expect.objectContaining({ status: ConsultationStatus.PENDING_REVIEW }),
      expect.any(Number),
    );
  });

  it('flags a note whose dose is absent from the transcript, feeding guardrailDecisions.safety (the existing hard-block field)', async () => {
    const { processor, summaryMetaRepository, contextItemRepository } = createProcessor({
      smrSummary: 'Prescribed lisinopril 20 mg once daily.',
    });
    // Transcript never mentions lisinopril or 20 mg.
    contextItemRepository.findTranscripts.mockResolvedValue([{ content: 'Patient reports headache.' }]);

    await processor.process(job());

    const written = summaryMetaRepository.create.mock.calls[0][0];
    expect(written.guardrailDecisions).toMatchObject({ safety: 'FLAG' });
  });

  it('does not flag when every note dose appears in the transcript', async () => {
    const noteText = 'Continue metformin 500 mg twice daily.';
    const { processor, summaryMetaRepository, contextItemRepository } = createProcessor({ smrSummary: noteText });
    contextItemRepository.findTranscripts.mockResolvedValue([{ content: 'We will keep you on metformin 500 mg twice daily.' }]);

    await processor.process(job());

    const written = summaryMetaRepository.create.mock.calls[0][0];
    expect(written.guardrailDecisions).not.toMatchObject({ safety: 'FLAG' });
  });

  it('runs the groundedness check advisory-only — an unverified verdict does not throw or block generation', async () => {
    const { processor, summaryMetaRepository } = createProcessor({ groundednessVerdict: 'unverified' });

    await expect(processor.process(job())).resolves.toBeDefined();

    const written = summaryMetaRepository.create.mock.calls[0][0];
    expect(written.guardrailDecisions).toMatchObject({ groundedness: expect.objectContaining({ verdict: 'unverified' }) });
    // Advisory only: groundedness alone must not set the safety hard-block.
    expect(written.guardrailDecisions).not.toMatchObject({ safety: 'FLAG' });
  });

  it('appends exactly one WORM GENERATE event per legacy generation', async () => {
    const { processor, harnessAuditService } = createProcessor();

    await processor.process(job());

    expect(harnessAuditService.append).toHaveBeenCalledTimes(1);
    expect(harnessAuditService.append).toHaveBeenCalledWith(expect.objectContaining({ action: HarnessAuditAction.GENERATE, consultationId: 'consult-1' }));
  });
});
