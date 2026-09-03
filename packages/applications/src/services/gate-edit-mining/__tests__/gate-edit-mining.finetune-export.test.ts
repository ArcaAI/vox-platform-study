/**
 * (C-6) — the fine-tuning export.
 *
 * R7's second clause is *"those will be used for fine-tuning and training
 * models"*. Before this ticket nothing anywhere assembled `(original, edited,
 * context)` triples into a dataset artifact — the nearest thing was a 500-row
 * JSON admin read of an always-empty table. So the clause was structurally
 * unmet: no code could consume the captured data for that purpose even once
 * mining was live.
 *
 * This is a TRAINING corpus, so it is stricter than both siblings:
 *
 *  * **Curation-GATED, unconditionally.** `retrieveExemplars` honours a
 *    default-off mode knob, and `exportCorpusCandidates` deliberately ships
 *    UNREVIEWED proposals for a human to triage. Neither is acceptable here: a
 *    training set assembled from unreviewed clinical text bakes an SME's absence
 *    into model weights, where it cannot be retracted. Only `APPROVED` rows.
 *  * **Redacted-only, and COMPLETE pairs only.** A row missing either side is
 *    dropped rather than exported half-formed — you cannot train on a pair whose
 *    "before" is absent, and substituting raw text would be a PHI leak.
 *  * **Explicitly tenant-scoped**, re-checked in the service exactly as the
 *    other two consumers do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { ExemplarCurationStatus } from '@arcaai/domains';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

const repository = {
  create: vi.fn(),
  update: vi.fn(),
  findByConsultation: vi.fn(),
  findTopForRetrieval: vi.fn(),
  findForCorpusExport: vi.fn(),
};

const cls = {
  get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : undefined)),
  set: vi.fn(),
  run: vi.fn(async (cb: () => unknown) => cb()),
};

function buildService() {
  return new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, { redact: vi.fn() } as never);
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  tenantId: TENANT,
  consultationId: 'c-1',
  departmentId: 'dept-1',
  visitType: 'new-patient',
  gateDecision: 'SIGNED',
  qualitySignal: 'APPROVED_CLEAN',
  curationStatus: ExemplarCurationStatus.APPROVED,
  editDistance: 3,
  editDistanceRatio: 0.02,
  timeToSignSeconds: 240,
  redactedBefore: 'S: [REDACTED] reports chest pain.',
  redactedAfter: 'S: [REDACTED] reports chest pain radiating to the left arm.',
  modelName: 'medgemma',
  promptTemplateId: 'tpl-1',
  createdAt: new Date('2026-07-20T10:04:00.000Z'),
  ...overrides,
});

describe('GateEditMiningService.exportFineTuningDataset (W4 / C-6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits one (original, edited, context) record per approved exemplar', async () => {
    repository.findForCorpusExport.mockResolvedValue([row()]);

    const result = await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    expect(result.count).toBe(1);
    const record = result.records[0];
    // The triple R7 names, explicitly.
    expect(record.original).toBe('S: [REDACTED] reports chest pain.');
    expect(record.edited).toBe('S: [REDACTED] reports chest pain radiating to the left arm.');
    expect(record.context.departmentId).toBe('dept-1');
    expect(record.context.visitType).toBe('new-patient');
    expect(record.context.qualitySignal).toBe('APPROVED_CLEAN');
    expect(record.context.editDistanceRatio).toBe(0.02);
  });

  it('labels every record with its provenance and redaction posture', async () => {
    repository.findForCorpusExport.mockResolvedValue([row()]);

    const result = await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    // A consumer must be able to tell REAL clinician behaviour from the harness's
    // synthetic golden fixture without consulting documentation.
    expect(result.records[0].provenance).toBe('CLINICIAN_EDIT');
    expect(result.records[0].phiRedaction).toBe('FULL');
    expect(result.reviewStatus).toBe('SME_APPROVED');
    expect(result.schemaVersion).toBeTruthy();
  });

  it('EXCLUDES exemplars that are not curation-APPROVED', async () => {
    repository.findForCorpusExport.mockResolvedValue([
      row({ id: 'pending', curationStatus: ExemplarCurationStatus.PENDING }),
      row({ id: 'rejected', curationStatus: ExemplarCurationStatus.REJECTED }),
      row({ id: 'missing', curationStatus: undefined }),
      row({ id: 'approved', curationStatus: ExemplarCurationStatus.APPROVED }),
    ]);

    const result = await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    expect(result.records.map((r) => r.exemplarId)).toEqual(['approved']);
  });

  it('drops a row missing either half of the pair rather than exporting it half-formed', async () => {
    repository.findForCorpusExport.mockResolvedValue([
      row({ id: 'no-before', redactedBefore: null }),
      row({ id: 'no-after', redactedAfter: null }),
      row({ id: 'complete' }),
    ]);

    const result = await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    expect(result.records.map((r) => r.exemplarId)).toEqual(['complete']);
  });

  it('re-checks the tenant boundary — a foreign row never reaches a training corpus', async () => {
    repository.findForCorpusExport.mockResolvedValue([row({ id: 'foreign', tenantId: OTHER_TENANT }), row({ id: 'mine' })]);

    const result = await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    expect(result.records.map((r) => r.exemplarId)).toEqual(['mine']);
  });

  it('serialises to JSONL — one complete JSON object per line', async () => {
    repository.findForCorpusExport.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    const service = buildService();
    const result = await service.exportFineTuningDataset({ tenantId: TENANT, limit: 10 });
    const jsonl = service.toJsonl(result);

    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      // A newline inside a record would corrupt the format — clinical notes are
      // multi-line, so this is the property that actually matters here.
      expect(line.includes('\n')).toBe(false);
    }
    expect(JSON.parse(lines[0]).exemplarId).toBe('a');
  });

  it('survives multi-line note bodies without breaking the JSONL framing', async () => {
    repository.findForCorpusExport.mockResolvedValue([row({ redactedAfter: 'S: line one\nO: line two\nA: line three' })]);

    const service = buildService();
    const jsonl = service.toJsonl(await service.exportFineTuningDataset({ tenantId: TENANT, limit: 10 }));

    expect(jsonl.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(jsonl.trim()).edited).toBe('S: line one\nO: line two\nA: line three');
  });

  it('bounds the export — an oversized limit is capped, never unbounded', async () => {
    repository.findForCorpusExport.mockResolvedValue([]);

    await buildService().exportFineTuningDataset({ tenantId: TENANT, limit: 10_000 });

    const passed = repository.findForCorpusExport.mock.calls[0][0] as { limit: number };
    expect(passed.limit).toBeLessThanOrEqual(500);
    expect(passed.tenantId).toBe(TENANT);
  });
});
