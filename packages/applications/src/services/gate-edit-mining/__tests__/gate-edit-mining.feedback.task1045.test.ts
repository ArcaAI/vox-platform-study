/**
 * Mining exemplars from clinician FEEDBACK: thumbs-down and corrections only,
 * PENDING redacted rows (source FEEDBACK), fail-closed redaction, entity
 * thumbs exported as de-identified NER labels, curation sink notified.
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { GateEditMiningProcessor, GateEditMiningQueue } from '../gate-edit-mining.processor';

const TENANT = 'tenant-1';

const repository = {
  create: vi.fn(async (entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
  findFirst: vi.fn(),
  findByConsultation: vi.fn(),
};
const cls = { get: vi.fn(), set: vi.fn(), run: vi.fn(async (cb: () => unknown) => cb()) };
const sink = { onFeedbackExemplar: vi.fn(async () => undefined) };
const redactor = { redact: vi.fn(async (text: string) => text.replace(/John Smith/g, '[REDACTED]')) };

/** Platform switch `gateEdit.exemplarCapture.enabled` resolved ON (it defaults OFF). */
const CAPTURE_ON = { resolveEffective: vi.fn(async (key: string) => ({ key, value: true, tier: 'global-kv', sourceScope: 'system' })) };

function build(r: { redact: ReturnType<typeof vi.fn> } | null = redactor, s: unknown = sink) {
  return new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, (r ?? undefined) as never, CAPTURE_ON as never, s as never);
}

const base = {
  tenantId: TENANT,
  consultationId: 'c1',
  feedbackId: 'fb1',
  targetKind: 'NOTE',
  reasonCodes: ['wrong_section'],
  departmentId: 'dept-1',
  visitType: 'new-patient',
  contextItemId: 'item-1',
};

describe('GateEditMiningService.mineFromFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findFirst.mockRejectedValue(new DataNotFoundException('gateEditExemplar', 'x'));
    redactor.redact.mockImplementation(async (text: string) => text.replace(/John Smith/g, '[REDACTED]'));
  });

  it('thumbs-down: writes a PENDING, redacted FEEDBACK row carrying reason codes and target kind', async () => {
    await build().mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'S: John Smith has chest pain.' });

    expect(repository.create).toHaveBeenCalledTimes(1);
    const row = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      tenantId: TENANT,
      consultationId: 'c1',
      source: 'FEEDBACK',
      feedbackId: 'fb1',
      reasonCodes: ['wrong_section'],
      targetKind: 'NOTE',
      curationStatus: 'PENDING',
      redactedAfter: null,
    });
    expect(row.redactedBefore).toBe('S: [REDACTED] has chest pain.');
  });

  it('correction: stores redacted before/after and the edit distance', async () => {
    await build().mineFromFeedback({
      ...base,
      rating: null,
      beforeContent: 'S: John Smith has chest pain.',
      afterContent: 'S: John Smith has chest pain on exertion.',
    });
    const row = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(row.redactedBefore).toBe('S: [REDACTED] has chest pain.');
    expect(row.redactedAfter).toBe('S: [REDACTED] has chest pain on exertion.');
    expect(row.editDistance).toBeGreaterThan(0);
  });

  it.each(['UP', 'CLEARED'])('ignores %s ratings without a correction', async (rating) => {
    await build().mineFromFeedback({ ...base, rating, targetContent: 'text' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('ignores a comment-only feedback (no rating, no correction)', async () => {
    await build().mineFromFeedback({ ...base, rating: null, targetContent: 'text' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a throwing redactor drops the candidate', async () => {
    await build({ redact: vi.fn().mockRejectedValue(new Error('down')) }).mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'x y z' });
    expect(repository.create).not.toHaveBeenCalled();
    expect(sink.onFeedbackExemplar).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: with no redactor wired nothing is stored', async () => {
    await build(null).mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'x y z' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('drops the whole candidate when only the AFTER side fails redaction', async () => {
    redactor.redact.mockImplementation(async (text: string) => {
      if (text.includes('after')) throw new Error('boom');
      return text;
    });
    await build().mineFromFeedback({ ...base, rating: null, beforeContent: 'before text here', afterContent: 'after text here' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('entity thumbs-down: exports the redacted entity text with its de-identified NER label', async () => {
    await build().mineFromFeedback({ ...base, targetKind: 'ENTITY', rating: 'DOWN', entityText: 'John Smith', entityLabel: 'PERSON', targetContent: undefined });
    const row = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({ targetKind: 'ENTITY', redactedBefore: '[REDACTED]', redactedAfter: 'PERSON' });
    expect(JSON.stringify(row)).not.toContain('John Smith');
  });

  it('entity thumbs-down: dropped when the entity text cannot be redacted', async () => {
    await build({ redact: vi.fn().mockRejectedValue(new Error('down')) }).mineFromFeedback({
      ...base,
      targetKind: 'ENTITY',
      rating: 'DOWN',
      entityText: 'John Smith',
      entityLabel: 'PERSON',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('is idempotent on the feedback id: a replay refreshes the existing row instead of inserting', async () => {
    const existing = { id: 'ex1', redactedBefore: 'old' };
    repository.findFirst.mockResolvedValue(existing);
    await build().mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'new text' });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('ex1', existing);
  });

  it('notifies the eval-gate curation sink with ids and kind only (no text)', async () => {
    await build().mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'S: John Smith.' });
    expect(sink.onFeedbackExemplar).toHaveBeenCalledTimes(1);
    const arg = sink.onFeedbackExemplar.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ tenantId: TENANT, consultationId: 'c1', feedbackId: 'fb1', targetKind: 'NOTE', reasonCodes: ['wrong_section'] });
    expect(JSON.stringify(arg)).not.toContain('Smith');
  });

  it('a throwing sink never fails the mining', async () => {
    const bad = { onFeedbackExemplar: vi.fn().mockRejectedValue(new Error('sink')) };
    await expect(build(redactor, bad).mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'x y' })).resolves.toBeUndefined();
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('never throws into the caller when the store fails', async () => {
    repository.create.mockRejectedValueOnce(new Error('db'));
    await expect(build().mineFromFeedback({ ...base, rating: 'DOWN', targetContent: 'x y' })).resolves.toBeUndefined();
  });
});

describe('queue + processor for feedback jobs', () => {
  const queue = { add: vi.fn(async () => undefined) };

  it('enqueue gives a feedback job its own job id so it is not deduped against the gate job', async () => {
    const q = new GateEditMiningQueue(queue as never);
    await q.enqueue({ tenantId: TENANT, consultationId: 'c1', gateDecision: 'PASS' });
    await q.enqueue({ tenantId: TENANT, consultationId: 'c1', gateDecision: 'FEEDBACK', source: 'feedback', feedbackId: 'fb1' });
    const ids = queue.add.mock.calls.map((c: unknown[]) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toContain('fb1');
  });

  it('processor loads the feedback + target text and routes to mineFromFeedback (not the gate path)', async () => {
    const mining = { mineFromGateDecision: vi.fn(), mineFromFeedback: vi.fn(async () => undefined) };
    const versions = {
      getVersion: vi.fn(async (_item: string, n: number) => ({ content: `v${n} John` })),
      getLatestVersionNumber: vi.fn(async () => 4),
      getVersionsByChangeReason: vi.fn(async () => []),
    };
    const feedbackRepo = {
      findByIdOrNull: vi.fn(async () => ({
        id: 'fb1',
        tenantId: TENANT,
        consultationId: 'c1',
        rating: 'DOWN',
        reasonCodes: ['too_long'],
        targetKind: 'NOTE',
        targetContextItemId: 'item-1',
        targetVersionNumber: 2,
        correctionContextItemId: 'item-1',
        correctionVersionNumber: 5,
        provModelName: 'm',
        entityLabel: null,
        targetEntityRef: null,
      })),
    };
    const consultations = { findById: vi.fn(async () => ({ departmentId: 'dept-1', doctorId: 'd1', parentConsultationId: null, metadata: {} })) };
    const procCls = { get: vi.fn(), set: vi.fn(), run: vi.fn(async (cb: () => unknown) => cb()), getId: vi.fn() };
    const processor = new GateEditMiningProcessor(
      mining as never,
      {} as never,
      versions as never,
      consultations as never,
      procCls as never,
      undefined,
      undefined,
      undefined,
      feedbackRepo as never,
    );
    await processor.process({ id: 'j1', data: { tenantId: TENANT, consultationId: 'c1', gateDecision: 'FEEDBACK', source: 'feedback', feedbackId: 'fb1' } } as never);

    expect(mining.mineFromGateDecision).not.toHaveBeenCalled();
    expect(mining.mineFromFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        feedbackId: 'fb1',
        rating: 'DOWN',
        reasonCodes: ['too_long'],
        targetKind: 'NOTE',
        targetContent: 'v2 John',
        beforeContent: 'v4 John',
        afterContent: 'v5 John',
        departmentId: 'dept-1',
      }),
    );
  });
});
