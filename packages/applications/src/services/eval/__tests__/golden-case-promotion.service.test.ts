/**
 * TASK-792 W3 (C-5) — an automated producer for `GoldenCase`.
 *
 * Before this ticket the ONLY write path was a manual admin POST. Nothing
 * connected a signed, clinician-edited consultation — or a curated
 * `GateEditExemplar` — into a golden case; curation only advanced a row's
 * `curationStatus` and stopped there.
 *
 * ── The honesty constraint, which shapes the whole design ──
 *
 * `apps/harness/src/harness/eval/golden/sources.py` declares the shipped fixture
 * SYNTHETIC, and the REAL clinician-authored set (multi-rater `clinical_v1`,
 * owned and versioned by a clinical SME) an outstanding prerequisite that
 * "MUST replace this fixture before any eval result is used to gate a clinical
 * claim."
 *
 * A case promoted here is derived from REAL clinician behaviour, which is
 * strictly better than synthetic — but it is NOT the SME-authored set, and it
 * must never be mistaken for it. So every promoted case is stamped
 * `CLINICIAN_DERIVED_PENDING_SME`, in-band on the row, and the promotion refuses
 * any exemplar a curator has not approved.
 *
 * ── Why a transcript read, and not exemplar.redactedBefore ──
 *
 * A golden case is a `(transcript -> reference note)` pair. An exemplar holds
 * `(AI draft -> signed note)`. Those are DIFFERENT pairs: putting `redactedBefore`
 * in the transcript slot would quietly train and grade the eval against an AI
 * draft masquerading as a clinical transcript. The signed note is a genuine gold
 * reference; the transcript has to come from the consultation itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExemplarCurationStatus } from '@arcaai/domains';
import { GoldenCasePromotionService, GOLDEN_CASE_CLINICIAN_DERIVED_LABEL } from '../golden-case-promotion.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const EXEMPLAR = 'ex-1';
const GOLDEN_SET = 'gs-1';

const exemplarRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXEMPLAR,
  tenantId: TENANT,
  consultationId: 'c-1',
  departmentId: 'dept-1',
  curationStatus: ExemplarCurationStatus.APPROVED,
  qualitySignal: 'APPROVED_CLEAN',
  redactedBefore: 'S: [REDACTED] draft.',
  redactedAfter: 'S: [REDACTED] reports chest pain radiating to the left arm.',
  ...overrides,
});

function makeMocks() {
  return {
    exemplarRepository: { findById: vi.fn().mockResolvedValue(exemplarRow()) },
    goldenSetRepository: { findById: vi.fn().mockResolvedValue({ id: GOLDEN_SET, tenantId: TENANT }) },
    contextItemRepository: {
      findTranscripts: vi.fn().mockResolvedValue([{ content: 'Doctor: what brings you in?' }, { content: 'Patient: chest pain.' }]),
    },
    evalService: { createGoldenCase: vi.fn(async (input: unknown) => ({ id: 'gc-1', ...(input as object) })) },
    // Strips the PHI marker the fixtures plant, so "unchanged output" is a
    // detectable redactor failure rather than a silent pass-through.
    phiRedactor: { redact: vi.fn(async (t: string) => t.replace(/John Smith/g, '[REDACTED]')) },
  };
}

const build = (m: ReturnType<typeof makeMocks>) =>
  new GoldenCasePromotionService(
    m.exemplarRepository as never,
    m.goldenSetRepository as never,
    m.contextItemRepository as never,
    m.evalService as never,
    m.phiRedactor as never,
  );

const promote = (m: ReturnType<typeof makeMocks>) =>
  build(m).promoteExemplarToGoldenCase({ tenantId: TENANT, exemplarId: EXEMPLAR, goldenSetId: GOLDEN_SET });

describe('GoldenCasePromotionService (W3 / C-5)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    vi.clearAllMocks();
    m = makeMocks();
  });

  it('promotes a curated exemplar into a golden case (transcript -> signed note)', async () => {
    await promote(m);

    expect(m.evalService.createGoldenCase).toHaveBeenCalledTimes(1);
    const input = m.evalService.createGoldenCase.mock.calls[0][0] as Record<string, string>;
    expect(input.tenantId).toBe(TENANT);
    expect(input.goldenSetId).toBe(GOLDEN_SET);
    // The REFERENCE is the clinician's signed note — the gold half of the pair.
    expect(input.referenceNote).toBe('S: [REDACTED] reports chest pain radiating to the left arm.');
    // The transcript comes from the consultation, joined in order.
    expect(input.transcript).toContain('what brings you in?');
    expect(input.transcript).toContain('chest pain.');
  });

  it('NEVER uses the AI draft as the transcript', async () => {
    await promote(m);

    const input = m.evalService.createGoldenCase.mock.calls[0][0] as Record<string, string>;
    // redactedBefore is the AI draft; a golden case whose "transcript" is a draft
    // would grade the model against its own output.
    expect(input.transcript).not.toContain('draft');
  });

  it('stamps the clinician-derived, SME-pending provenance on the row', async () => {
    await promote(m);

    const input = m.evalService.createGoldenCase.mock.calls[0][0] as Record<string, string>;
    expect(input.label).toContain(GOLDEN_CASE_CLINICIAN_DERIVED_LABEL);
    // Traceable back to the exemplar it came from.
    expect(input.label).toContain(EXEMPLAR);
  });

  it('redacts the transcript before it is persisted', async () => {
    m.contextItemRepository.findTranscripts.mockResolvedValue([{ content: 'Patient John Smith reports chest pain.' }]);

    await promote(m);

    expect(m.phiRedactor.redact).toHaveBeenCalledWith(expect.stringContaining('John Smith'), 'full');
    const input = m.evalService.createGoldenCase.mock.calls[0][0] as Record<string, string>;
    expect(input.transcript).not.toContain('John Smith');
    expect(input.transcript).toContain('[REDACTED]');
  });

  it('REFUSES an exemplar the curator has not approved', async () => {
    m.exemplarRepository.findById.mockResolvedValue(exemplarRow({ curationStatus: ExemplarCurationStatus.PENDING }));

    await expect(promote(m)).rejects.toThrow();
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('returns 404 for a cross-tenant exemplar (404-over-403), never 403', async () => {
    m.exemplarRepository.findById.mockResolvedValue(exemplarRow({ tenantId: OTHER_TENANT }));

    await expect(promote(m)).rejects.toMatchObject({ status: 404 });
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('returns 404 for a golden set belonging to another tenant', async () => {
    m.goldenSetRepository.findById.mockResolvedValue({ id: GOLDEN_SET, tenantId: OTHER_TENANT });

    await expect(promote(m)).rejects.toMatchObject({ status: 404 });
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the consultation has no transcript — never fabricates one', async () => {
    m.contextItemRepository.findTranscripts.mockResolvedValue([]);

    await expect(promote(m)).rejects.toThrow();
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when redaction cannot be verified', async () => {
    m.phiRedactor.redact.mockRejectedValue(new Error('guardrail down'));

    await expect(promote(m)).rejects.toThrow();
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the redactor returns the input unchanged on identifying text', async () => {
    // A no-op redactor is otherwise indistinguishable from a clean one, and
    // persisting its output would be persisting raw PHI into an eval corpus.
    m.contextItemRepository.findTranscripts.mockResolvedValue([{ content: 'Patient Jane Doe, DOB 1985-02-03.' }]);
    m.phiRedactor.redact.mockImplementation(async (t: string) => t);

    await expect(promote(m)).rejects.toThrow();
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the exemplar carries no signed note to use as the reference', async () => {
    m.exemplarRepository.findById.mockResolvedValue(exemplarRow({ redactedAfter: null }));

    await expect(promote(m)).rejects.toThrow();
    expect(m.evalService.createGoldenCase).not.toHaveBeenCalled();
  });
});
