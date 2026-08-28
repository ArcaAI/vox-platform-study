/**
 * TASK-792 — the feedback loop, end to end, in one spec.
 *
 * Every stage of this loop already existed and was individually correct. What did
 * not exist was any path CONNECTING them: the queue had no call site, the
 * processor was in no module, and the retriever was provided to nothing. Unit
 * tests stayed green throughout, because each stage was tested against a mock of
 * the stage next to it.
 *
 * So this test deliberately mocks only the EDGES — repositories, the redactor,
 * the queue transport — and runs the real `SummaryService`, the real
 * `GateEditMiningProcessor`, the real `GateEditMiningService` and the real
 * `PromptAssemblyService` against each other:
 *
 *   clinician signs  ->  approveSummary enqueues
 *                    ->  processor reads the ai_draft_v1 baseline + signed note
 *                    ->  mining service redacts BOTH halves and persists
 *                    ->  retriever serves the APPROVED_CLEAN exemplar
 *                    ->  prompt assembly injects it as a few-shot example
 *
 * The two assertions that matter are the ticket's definition of done: the mined
 * row carries BOTH `redactedBefore` and `redactedAfter` (a half-redacted or
 * half-populated exemplar is useless for training and unsafe to retain), and an
 * `APPROVED_CLEAN` exemplar actually reaches an assembled prompt.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationEntity, ConsultationStatus } from '@arcaai/domains';
import { SummaryService } from '../../consultation/summary/summary.service';
import { PromptAssemblyService } from '../../consultation/prompt/prompt-assembly.service';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { GateEditMiningProcessor } from '../gate-edit-mining.processor';

const TENANT = 'tenant-e2e';
const CONSULTATION = 'consult-e2e';
const CONTEXT_ITEM = 'ci-e2e';

// The AI draft as delivered, and the note the clinician actually signed.
//
// Realistically sized (47 words) on purpose: the mined label is a RATIO, so a
// toy two-line note cannot express a small edit at all. Here the clinician
// changed only the review interval — 2 words of 47, a ratio of ~0.043, under the
// 0.05 APPROVED_CLEAN threshold. That is the "imitate this" signal few-shot
// retrieval serves. A larger edit would land in the ambiguous band and be
// deliberately not mined.
const AI_DRAFT =
  'S: Patient John Smith reports intermittent chest pain for three days, worse on exertion and relieved by rest. ' +
  'O: Blood pressure 130/80, heart rate 72, lungs clear to auscultation bilaterally. ' +
  'A: Stable angina, moderate cardiovascular risk. ' +
  'P: Start aspirin, arrange exercise tolerance testing, review in two weeks.';
const SIGNED_NOTE =
  'S: Patient John Smith reports intermittent chest pain for three days, worse on exertion and relieved by rest. ' +
  'O: Blood pressure 130/80, heart rate 72, lungs clear to auscultation bilaterally. ' +
  'A: Stable angina, moderate cardiovascular risk. ' +
  'P: Start aspirin, arrange exercise tolerance testing, review in one week.';

/** Strips the planted identifiers, so a no-op redactor is detectable. */
const redactor = { redact: vi.fn(async (text: string) => text.replace(/John Smith|1985-02-03/g, '[REDACTED]')) };

const cls = () => ({
  get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'doctor-1' } : undefined)),
  set: vi.fn(),
  run: vi.fn(async (cb: () => unknown) => cb()),
});

describe('TASK-792 — clinician edit -> mined exemplar -> assembled prompt', () => {
  it('runs the whole loop: a signed edit becomes a redacted exemplar that reaches a prompt', async () => {
    // ── the store the loop writes into and later reads back out of ──────────
    const persisted: Record<string, unknown>[] = [];
    const exemplarRepository = {
      create: vi.fn(async (entity: Record<string, unknown>) => {
        persisted.push(entity);
        return entity;
      }),
      update: vi.fn(),
      findByConsultation: vi.fn().mockResolvedValue(null),
      // Retrieval reads back exactly what mining wrote.
      findTopForRetrieval: vi.fn(async () => persisted.filter((r) => r.qualitySignal === 'APPROVED_CLEAN')),
      findForCorpusExport: vi.fn(),
    };

    const miningService = new GateEditMiningService(
      exemplarRepository as never,
      { emit: vi.fn() } as never,
      cls() as never,
      redactor as never,
    );

    // ── STAGE 1: the clinician signs ────────────────────────────────────────
    // The queue transport is faked, but the JOB it carries is the real one, and
    // it is handed straight to the real processor below.
    const jobs: Record<string, unknown>[] = [];
    const miningQueue = { enqueue: vi.fn(async (job: Record<string, unknown>) => void jobs.push(job)) };

    const contextItem = {
      id: CONTEXT_ITEM,
      tenantId: TENANT,
      consultationId: CONSULTATION,
      isFinalSummary: true,
      content: SIGNED_NOTE,
      currentVersionNumber: 2,
      version: 2,
    };

    const summaryService = new SummaryService(
      { findById: vi.fn().mockResolvedValue(contextItem), updateWithVersion: vi.fn(async () => contextItem), encryptContentIntoEntity: vi.fn() } as never,
      {
        findById: vi.fn().mockResolvedValue(
          new ConsultationEntity({
            id: CONSULTATION,
            tenantId: TENANT,
            patientId: 'p-1',
            departmentId: null,
            doctorId: 'doctor-1',
            parentConsultationId: null,
            appointmentDate: new Date('2026-01-01'),
            metadata: null,
            degradedReasons: [],
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-01'),
            createdBy: 'u-1',
            status: ConsultationStatus.PENDING_REVIEW,
            version: 1,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
        ),
        updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
      } as never,
      { findByContextItem: vi.fn().mockResolvedValue(null) } as never,
      { create: vi.fn() } as never,
      { axiosRef: { post: vi.fn() } } as never,
      { get: vi.fn(() => undefined) } as never,
      { emit: vi.fn() } as never,
      cls() as never,
      { create: vi.fn(async (e: unknown) => e), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
      { assemble: vi.fn() } as never,
      undefined, undefined,
      { append: vi.fn().mockResolvedValue({ id: 'a-1' }) } as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      miningQueue as never,
    );

    await summaryService.approveSummary(CONTEXT_ITEM, { expectedVersion: 2 });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: CONTEXT_ITEM });

    // ── STAGE 2: the worker mines the job ───────────────────────────────────
    // The versions the processor reads: the IMMUTABLE ai_draft_v1 baseline and
    // the signed note. This is the pair R7 says must be retained together.
    const versionsByReason: Record<string, { content: string }[]> = {
      ai_draft_v1: [{ content: AI_DRAFT }],
      approved: [{ content: SIGNED_NOTE }],
    };

    const processor = new GateEditMiningProcessor(
      miningService,
      {} as never,
      { getVersionsByChangeReason: vi.fn(async (_id: string, reason: string) => versionsByReason[reason] ?? []) } as never,
      { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, departmentId: null, parentConsultationId: null }) } as never,
      cls() as never,
    );

    await processor.process({ id: 'job-1', data: jobs[0] } as never);

    // DoD: the exemplar exists and carries BOTH redacted halves.
    expect(persisted).toHaveLength(1);
    const exemplar = persisted[0];
    expect(exemplar.redactedBefore).toBeTruthy();
    expect(exemplar.redactedAfter).toBeTruthy();
    expect(exemplar.qualitySignal).toBe('APPROVED_CLEAN');
    // The original is retained BESIDE the edit, and neither carries the identifier.
    expect(exemplar.redactedBefore).toContain('[REDACTED]');
    expect(exemplar.redactedAfter).toContain('[REDACTED]');
    expect(String(exemplar.redactedBefore)).not.toContain('John Smith');
    expect(String(exemplar.redactedAfter)).not.toContain('John Smith');
    // They are genuinely the two DIFFERENT versions, not the same text twice.
    expect(exemplar.redactedBefore).not.toBe(exemplar.redactedAfter);

    // ── STAGE 3: the exemplar reaches an assembled prompt ───────────────────
    const promptAssembly = new PromptAssemblyService(
      { resolve: vi.fn().mockResolvedValue({ promptId: null, content: 'Summarize the transcript.', resolvedFrom: 'default' }) } as never,
      { findById: vi.fn().mockResolvedValue(null) } as never,
      { findById: vi.fn().mockResolvedValue(null) } as never,
      { get: vi.fn() } as never,
      { getEffectivePolicy: vi.fn().mockResolvedValue({ warmStartEnabled: false }) } as never,
      cls() as never,
      // The SAME mining service instance — its read half, unmocked.
      miningService as never,
    );

    const assembled = await promptAssembly.assemble({
      tenantId: TENANT,
      departmentId: null,
      promptType: 'SUMMARY',
      transcript: 'Doctor: what brings you in today?',
    } as never);

    // DoD: an APPROVED_CLEAN exemplar actually reaches the prompt.
    expect(assembled.userPrompt).toContain('STYLE REFERENCE');
    expect(assembled.userPrompt).toContain('review in one week.');
    // The AI draft's wording is NOT what was injected.
    expect(assembled.userPrompt).not.toContain('review in two weeks.');
    // ...and only the REDACTED signed note does. The AI draft is never shown to
    // the model, and no identifier survives into the prompt.
    expect(assembled.userPrompt).not.toContain('John Smith');
    expect(exemplarRepository.findTopForRetrieval).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN' }),
    );
  });
});
