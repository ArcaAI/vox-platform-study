/**
 * TASK-1062 D-3 — exemplars carry structure at REST, not only at use.
 *
 * TASK-1061 made `retrieveExemplars` hand a prompt `toStructureOnlyExemplar(redactedAfter)`, but the
 * stored row still held the full note and the prompt path still read it. Now:
 *
 *  * every save (gate mining, feedback mining; create and the idempotent refresh) writes BOTH
 *    `redactedAfter` (the full redacted note) and `structureAfter` (its skeleton);
 *  * retrieval reads ONLY `structureAfter` — it never transforms or returns `redactedAfter`, and a
 *    row without `structureAfter` (mined before the column, not yet backfilled) is skipped;
 *  * the SME corpus export and the fine-tune export keep using `redactedAfter`, unchanged.
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { ExemplarCurationStatus } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toStructureOnlyExemplar } from '../exemplar-structure';
import { GateEditMiningService } from '../gate-edit-mining.service';

const TENANT = 'tenant-1';

/** A full signed note with facts a structure-only exemplar must never carry. */
const SIGNED = ['Assessment:', 'Type 2 diabetes, poorly controlled.', '', 'Plan:', '- Increase metformin 500 mg to 1000 mg twice daily.', '- Review HbA1c 8.4% on 12 Nov.'].join('\n');
const DELIVERED = ['Assessment:', 'Type 2 diabetes.', '', 'Plan:', '- Increase metformin 500 mg to 1000 mg twice daily.', '- Review HbA1c 8.4% on 12 Nov.'].join('\n');
const FACTS = ['metformin', '500', '1000', '8.4', 'Nov', 'diabetes', 'HbA1c'];

const repository = {
  create: vi.fn(async (entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
  findFirst: vi.fn(),
  findByConsultation: vi.fn(),
  findTopForRetrieval: vi.fn(),
  findForCorpusExport: vi.fn(),
};
const cls = { get: vi.fn(), set: vi.fn(), run: vi.fn(async (cb: () => unknown) => cb()) };
/** The note has no direct identifiers, so an identity redactor is a valid, verified redaction. */
const redactor = { redact: vi.fn(async (text: string) => text) };

/** Platform switch `gateEdit.exemplarCapture.enabled` resolved ON (it defaults OFF). */
const CAPTURE_ON = { resolveEffective: vi.fn(async (key: string) => ({ key, value: true, tier: 'global-kv', sourceScope: 'system' })) };

function build() {
  return new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, redactor as never, CAPTURE_ON as never);
}

const gateCandidate = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  consultationId: 'c-1',
  departmentId: 'dept-1',
  visitType: 'new-patient',
  gateDecision: 'PASS',
  deliveredContent: SIGNED,
  signedContent: SIGNED,
  ...overrides,
});

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  tenantId: TENANT,
  consultationId: 'c-1',
  departmentId: 'dept-1',
  visitType: 'new-patient',
  gateDecision: 'PASS',
  qualitySignal: 'APPROVED_CLEAN',
  curationStatus: ExemplarCurationStatus.APPROVED,
  editDistance: 0,
  editDistanceRatio: 0,
  timeToSignSeconds: 30,
  redactedBefore: DELIVERED,
  redactedAfter: SIGNED,
  structureAfter: toStructureOnlyExemplar(SIGNED),
  modelName: 'm',
  promptTemplateId: null,
  createdAt: new Date('2026-10-11T00:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByConsultation.mockResolvedValue(null);
  repository.findFirst.mockRejectedValue(new DataNotFoundException('gateEditExemplar', 'x'));
});

describe('save writes both columns', () => {
  it('gate mining (create): redactedAfter is the full note, structureAfter its skeleton', async () => {
    await build().mineFromGateDecision(gateCandidate());

    expect(repository.create).toHaveBeenCalledTimes(1);
    const row = repository.create.mock.calls[0]![0] as { redactedAfter: string; structureAfter: string };
    expect(row.redactedAfter).toBe(SIGNED);
    expect(row.structureAfter).toBe(toStructureOnlyExemplar(SIGNED));
    for (const fact of FACTS) expect(row.structureAfter).not.toContain(fact);
    expect(row.structureAfter).toContain('Plan:');
  });

  it('gate mining (idempotent refresh of an existing row): both columns are rewritten', async () => {
    const existing = { id: 'ex-1', tenantId: TENANT, redactedAfter: 'old', structureAfter: null } as Record<string, unknown>;
    repository.findByConsultation.mockResolvedValue(existing);

    await build().mineFromGateDecision(gateCandidate());

    expect(repository.update).toHaveBeenCalledWith('ex-1', existing);
    expect(existing.redactedAfter).toBe(SIGNED);
    expect(existing.structureAfter).toBe(toStructureOnlyExemplar(SIGNED));
  });

  it('feedback correction (create): structureAfter is the skeleton of the corrected note', async () => {
    await build().mineFromFeedback({
      tenantId: TENANT,
      consultationId: 'c-1',
      feedbackId: 'fb-1',
      targetKind: 'NOTE',
      rating: null,
      beforeContent: DELIVERED,
      afterContent: SIGNED,
    } as never);

    const row = repository.create.mock.calls[0]![0] as { redactedAfter: string; structureAfter: string };
    expect(row.redactedAfter).toBe(SIGNED);
    expect(row.structureAfter).toBe(toStructureOnlyExemplar(SIGNED));
  });

  it('feedback thumbs-down (no after text): structureAfter is null', async () => {
    await build().mineFromFeedback({ tenantId: TENANT, consultationId: 'c-1', feedbackId: 'fb-1', targetKind: 'NOTE', rating: 'DOWN', targetContent: DELIVERED } as never);

    const row = repository.create.mock.calls[0]![0] as { redactedAfter: unknown; structureAfter: unknown };
    expect(row.redactedAfter).toBeNull();
    expect(row.structureAfter).toBeNull();
  });

  it('feedback correction (idempotent refresh): both columns are rewritten', async () => {
    const existing = { id: 'ex-2', tenantId: TENANT, redactedAfter: 'old', structureAfter: 'old' } as Record<string, unknown>;
    repository.findFirst.mockResolvedValue(existing);

    await build().mineFromFeedback({
      tenantId: TENANT,
      consultationId: 'c-1',
      feedbackId: 'fb-1',
      targetKind: 'NOTE',
      rating: null,
      beforeContent: DELIVERED,
      afterContent: SIGNED,
    } as never);

    expect(existing.redactedAfter).toBe(SIGNED);
    expect(existing.structureAfter).toBe(toStructureOnlyExemplar(SIGNED));
  });
});

describe('retrieval reads only structureAfter', () => {
  it('returns the stored structure verbatim and never the redactedAfter content', async () => {
    // A stored skeleton that differs from what the transform would produce from redactedAfter
    // proves the read is the COLUMN, not a re-derivation from the full note.
    repository.findTopForRetrieval.mockResolvedValue([storedRow({ structureAfter: 'Plan:\n- <DRUG> <DOSE>' })]);

    const result = await build().retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(result).toEqual([{ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', redactedAfter: 'Plan:\n- <DRUG> <DOSE>' }]);
    const serialised = JSON.stringify(result);
    for (const fact of FACTS) expect(serialised).not.toContain(fact);
  });

  it('skips a row without structureAfter, even when its redactedAfter is present', async () => {
    repository.findTopForRetrieval.mockResolvedValue([storedRow({ id: 'legacy', structureAfter: null }), storedRow({ id: 'fresh' })]);

    const result = await build().retrieveExemplars({ tenantId: TENANT, limit: 3 });

    expect(result).toHaveLength(1);
    expect(result[0]?.redactedAfter).toBe(toStructureOnlyExemplar(SIGNED));
    expect(JSON.stringify(result)).not.toContain('metformin');
  });
});

describe('exports keep redactedAfter', () => {
  it('the SME corpus export carries redactedAfter (the full redacted note) and not the skeleton', async () => {
    repository.findForCorpusExport.mockResolvedValue([storedRow()]);

    const exported = await build().exportCorpusCandidates({ tenantId: TENANT, limit: 10 });

    expect(exported.candidates[0]?.redactedAfter).toBe(SIGNED);
    expect(exported.candidates[0]).not.toHaveProperty('structureAfter');
  });

  it('the fine-tune export pairs redactedBefore with redactedAfter', async () => {
    repository.findForCorpusExport.mockResolvedValue([storedRow()]);

    const dataset = await build().exportFineTuningDataset({ tenantId: TENANT, limit: 10 });

    expect(dataset.records[0]?.original).toBe(DELIVERED);
    expect(dataset.records[0]?.edited).toBe(SIGNED);
  });
});
