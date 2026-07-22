/**
 * GateEditMiningService — the learning loop's write + read halves.
 *
 * The clinician approve-vs-edit signal was fully captured and consumed by
 * nothing: gate decisions in the WORM `HarnessAuditEvent`, delivered-vs-signed
 * content in `RAW_SUMMARY`/`MODIFIED_SUMMARY` versions, derived scalars in the
 * edit-burden telemetry. This service turns it into retrievable exemplars.
 *
 * The two properties that must never regress:
 *
 *  1. **Redaction is FAIL-CLOSED.** Raw note text must not reach the mining
 *     store. A redactor that errors, returns nothing, or leaves the text
 *     unchanged when it contained PHI drops the candidate entirely.
 *  2. **Retrieval is tenant + department bounded.** An exemplar from another
 *     tenant reaching a prompt would be a cross-tenant PHI leak of the worst
 *     kind — one laundered through a model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GateEditMiningService } from '../gate-edit-mining.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const CONSULTATION = 'consultation-1';

const repository = {
  create: vi.fn(async (entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
  findByConsultation: vi.fn(),
  findTopForRetrieval: vi.fn(),
  findForCorpusExport: vi.fn(),
};

const cls = {
  get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : undefined)),
  set: vi.fn(),
  run: vi.fn(async (cb: () => unknown) => cb()),
};

/** A redactor that strips the PHI markers our fixtures plant. */
const workingRedactor = {
  redact: vi.fn(async (text: string) => text.replace(/John Smith|1985-02-03/g, '[REDACTED]')),
};

function buildService(redactor: { redact: ReturnType<typeof vi.fn> } = workingRedactor) {
  return new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, redactor as never);
}

const candidate = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  consultationId: CONSULTATION,
  departmentId: 'dept-1',
  visitType: 'new-patient',
  gateDecision: 'PASS',
  deliveredContent: 'S: Patient John Smith reports chest pain.',
  signedContent: 'S: Patient John Smith reports chest pain radiating to the left arm.',
  deliveredAt: '2026-07-20T10:00:00.000Z',
  signedAt: '2026-07-20T10:04:00.000Z',
  ...overrides,
});

describe('GateEditMiningService — mining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findByConsultation.mockResolvedValue(null);
    workingRedactor.redact.mockImplementation(async (text: string) => text.replace(/John Smith|1985-02-03/g, '[REDACTED]'));
  });

  it('mines an exemplar carrying the derived edit-burden scalars', async () => {
    await buildService().mineFromGateDecision(candidate());

    expect(repository.create).toHaveBeenCalledTimes(1);
    const created = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.consultationId).toBe(CONSULTATION);
    expect(created.departmentId).toBe('dept-1');
    expect(created.gateDecision).toBe('PASS');
    expect(typeof created.editDistance).toBe('number');
    expect(created.timeToSignSeconds).toBe(240);
  });

  it('classifies an unedited sign-off as APPROVED_CLEAN', async () => {
    await buildService().mineFromGateDecision(candidate({ signedContent: 'S: Patient John Smith reports chest pain.' }));

    expect((repository.create.mock.calls[0][0] as { qualitySignal: string }).qualitySignal).toBe('APPROVED_CLEAN');
  });

  it('classifies a materially reworked note as HEAVILY_EDITED', async () => {
    await buildService().mineFromGateDecision(
      candidate({ signedContent: 'S: Completely different narrative with new findings and a revised plan entirely.' }),
    );

    expect((repository.create.mock.calls[0][0] as { qualitySignal: string }).qualitySignal).toBe('HEAVILY_EDITED');
  });

  it('stores only REDACTED snippets — raw PHI never reaches the store', async () => {
    await buildService().mineFromGateDecision(candidate());

    const created = repository.create.mock.calls[0][0] as { redactedBefore: string; redactedAfter: string };
    expect(created.redactedBefore).not.toContain('John Smith');
    expect(created.redactedAfter).not.toContain('John Smith');
    expect(created.redactedBefore).toContain('[REDACTED]');
  });

  it('FAIL-CLOSED: a redactor that throws drops the candidate', async () => {
    const broken = { redact: vi.fn().mockRejectedValue(new Error('guardrail down')) };

    await buildService(broken).mineFromGateDecision(candidate());

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a redactor returning empty output drops the candidate', async () => {
    const empty = { redact: vi.fn().mockResolvedValue('') };

    await buildService(empty).mineFromGateDecision(candidate());

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: unchanged output on PHI-bearing text drops the candidate', async () => {
    // A no-op redactor is indistinguishable from an unconfigured one. Storing
    // its output would be storing raw PHI, so treat "nothing changed" on text we
    // know carries PHI as a redaction failure.
    const noop = { redact: vi.fn(async (text: string) => text) };

    await buildService(noop).mineFromGateDecision(candidate());

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('is IDEMPOTENT — a replayed event updates rather than duplicating', async () => {
    repository.findByConsultation.mockResolvedValue({ id: 'exemplar-1', tenantId: TENANT, consultationId: CONSULTATION });

    await buildService().mineFromGateDecision(candidate());

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it('never throws into the caller — mining is best-effort, off the sign path', async () => {
    repository.create.mockRejectedValueOnce(new Error('db down'));

    await expect(buildService().mineFromGateDecision(candidate())).resolves.toBeUndefined();
  });

  it('skips a candidate with no signed content (nothing to learn from yet)', async () => {
    await buildService().mineFromGateDecision(candidate({ signedContent: null }));

    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('GateEditMiningService — retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findTopForRetrieval.mockResolvedValue([]);
  });

  it('retrieves APPROVED_CLEAN exemplars for the caller tenant + department', async () => {
    await buildService().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(repository.findTopForRetrieval).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, departmentId: 'dept-1', qualitySignal: 'APPROVED_CLEAN' }),
    );
  });

  it('hard-caps the requested limit — retrieval sits on the prompt hot path', async () => {
    await buildService().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 10_000 });

    const { limit } = repository.findTopForRetrieval.mock.calls[0][0] as { limit: number };
    expect(limit).toBeLessThanOrEqual(5);
  });

  it("never returns another tenant's exemplars", async () => {
    // The repository + tenant-scope extension enforce this; the service must not
    // undo it by passing a caller-supplied tenant through unchecked.
    repository.findTopForRetrieval.mockResolvedValue([
      { tenantId: OTHER_TENANT, redactedAfter: 'leaked', qualitySignal: 'APPROVED_CLEAN' },
      { tenantId: TENANT, redactedAfter: 'ok', qualitySignal: 'APPROVED_CLEAN' },
    ]);

    const result = await buildService().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(result.every((e) => e.tenantId === TENANT)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('returns an empty list rather than throwing when retrieval fails', async () => {
    repository.findTopForRetrieval.mockRejectedValue(new Error('db down'));

    await expect(buildService().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 })).resolves.toEqual([]);
  });

  it('omits exemplars with no redacted content — nothing to show the model', async () => {
    repository.findTopForRetrieval.mockResolvedValue([
      { tenantId: TENANT, redactedAfter: null, qualitySignal: 'APPROVED_CLEAN' },
      { tenantId: TENANT, redactedAfter: 'usable', qualitySignal: 'APPROVED_CLEAN' },
    ]);

    const result = await buildService().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(result).toHaveLength(1);
  });
});

/**
 * §3.4 consumption (a) — the eval regression-corpus export.
 *
 * The SME gate is the whole point of this half: mined rows are PROPOSALS, and
 * the golden-set programme decides what becomes corpus. So the export must
 * describe itself as unreviewed, and must never hand back anything that could
 * be mistaken for an approved corpus row.
 */
describe('GateEditMiningService — corpus export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ex-1',
    tenantId: TENANT,
    consultationId: CONSULTATION,
    departmentId: 'dept-1',
    visitType: 'new-patient',
    gateDecision: 'PASS',
    qualitySignal: 'APPROVED_CLEAN',
    editDistance: 4,
    editDistanceRatio: 0.02,
    timeToSignSeconds: 240,
    redactedBefore: 'BEFORE [REDACTED]',
    redactedAfter: 'AFTER [REDACTED]',
    modelName: 'm1',
    promptTemplateId: 't1',
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    ...over,
  });

  it('marks the payload as an UNREVIEWED proposal set (the SME gate)', async () => {
    repository.findForCorpusExport.mockResolvedValue([row()]);
    const service = buildService();

    const result = await service.exportCorpusCandidates({ tenantId: TENANT, limit: 10 });

    expect(result.reviewStatus).toBe('PENDING_SME_REVIEW');
    expect(result.candidates).toHaveLength(1);
  });

  it('exports BOTH quality signals when none is requested — a regression corpus needs failures too', async () => {
    repository.findForCorpusExport.mockResolvedValue([row(), row({ id: 'ex-2', qualitySignal: 'HEAVILY_EDITED' })]);
    const service = buildService();

    const result = await service.exportCorpusCandidates({ tenantId: TENANT, limit: 10 });

    expect(result.candidates.map((c) => c.qualitySignal).sort()).toEqual(['APPROVED_CLEAN', 'HEAVILY_EDITED']);
    expect(repository.findForCorpusExport).toHaveBeenCalledWith(expect.objectContaining({ qualitySignal: undefined }));
  });

  it('passes the requested department + quality filter through', async () => {
    repository.findForCorpusExport.mockResolvedValue([]);
    const service = buildService();

    await service.exportCorpusCandidates({ tenantId: TENANT, departmentId: 'dept-9', qualitySignal: 'HEAVILY_EDITED', limit: 25 });

    expect(repository.findForCorpusExport).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, departmentId: 'dept-9', qualitySignal: 'HEAVILY_EDITED' }),
    );
  });

  it('emits ONLY redacted content — no raw-note field is reachable through the export', async () => {
    repository.findForCorpusExport.mockResolvedValue([row()]);
    const service = buildService();

    const [candidateRow] = (await service.exportCorpusCandidates({ tenantId: TENANT, limit: 10 })).candidates;

    expect(candidateRow.redactedAfter).toBe('AFTER [REDACTED]');
    expect(JSON.stringify(candidateRow)).not.toMatch(/John Smith|1985-02-03/);
    expect(candidateRow).not.toHaveProperty('deliveredContent');
    expect(candidateRow).not.toHaveProperty('signedContent');
  });

  it("never exports another tenant's row even if the store returns one", async () => {
    repository.findForCorpusExport.mockResolvedValue([row(), row({ id: 'ex-3', tenantId: OTHER_TENANT })]);
    const service = buildService();

    const result = await service.exportCorpusCandidates({ tenantId: TENANT, limit: 10 });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].tenantId).toBe(TENANT);
  });

  it('hard-caps the requested limit', async () => {
    repository.findForCorpusExport.mockResolvedValue([]);
    const service = buildService();

    await service.exportCorpusCandidates({ tenantId: TENANT, limit: 100_000 });

    expect(repository.findForCorpusExport).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  it('PROPAGATES a store failure — unlike retrieval, a silent empty export would read as "no candidates"', async () => {
    repository.findForCorpusExport.mockRejectedValue(new Error('store down'));
    const service = buildService();

    await expect(service.exportCorpusCandidates({ tenantId: TENANT, limit: 10 })).rejects.toThrow('store down');
  });
});
