/**
 * TASK-1050 W2e — `POST internal/guardrail/evaluations`: the gateway is the ONE writer of guardrail
 * outcomes (README §9.7.1, §9.8.2). One transaction per batch: the evaluations (idempotent on
 * `evaluationId`), their notices (deduped), the item markers (current version only, never
 * downgraded, outside OCC) and, on a block, the consultation's resumable guardrail hold.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { GuardrailEvaluationRecord, GuardrailNotice } from '@arcaai/types';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../guardrail-notice/__tests__/support/w0-domains')),
}));

import { ConsultationProcessing, ConsultationStatus, GuardrailItemStatus, GuardrailNoticeStatus } from '@arcaai/domains';
import { GuardrailEvaluationIngestService } from '../guardrail-evaluation-ingest.service';
import { GuardrailHoldService } from '../../guardrail-notice/guardrail-hold.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const CONSULTATION = '01927f6e-0000-7000-8000-000000000001';
const SEG = '01927f6e-1111-7000-8000-000000000010';
const SEG2 = '01927f6e-1111-7000-8000-000000000011';

function notice(overrides: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return {
    schemaVersion: 1,
    noticeId: '01927f6e-9999-7000-8000-0000000000aa',
    type: 'guardrail.warning',
    direction: 'inbound',
    action: 'warn',
    checks: [{ checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' }],
    consultationId: CONSULTATION,
    runId: 'run-1',
    nodeId: 'n_note',
    itemIds: [SEG],
    messageKey: 'guardrail.warning.generic',
    defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
    requiresAcknowledgement: true,
    resumable: false,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...overrides,
  };
}

function blockNotice(overrides: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return notice({
    noticeId: '01927f6e-9999-7000-8000-0000000000bb',
    type: 'guardrail.blocked',
    action: 'block',
    checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
    messageKey: 'guardrail.blocked.inbound',
    defaultMessage: 'A safety check stopped this request. Review the flagged input to continue.',
    resumable: true,
    ...overrides,
  });
}

function record(overrides: Partial<GuardrailEvaluationRecord> = {}): GuardrailEvaluationRecord {
  const n = notice();
  return {
    evaluationId: '01927f6e-8b1a-7c3e-9d2f-1a2b3c4d5e60',
    tenantId: TENANT,
    requestId: 'req-1',
    consultationId: CONSULTATION,
    runId: 'run-1',
    runKey: 'scribe:1',
    nodeId: 'n_note',
    caller: 'harness.guardrail_check',
    direction: 'inbound',
    decision: 'warn',
    checks: [
      {
        checkId: 'unsafe_content_judge',
        verdict: 'flag',
        category: 'violence',
        confidence: 0.8,
        actionTaken: 'warn',
        model: 'granite',
        latencyMs: 12,
        regionKeys: ['transcript:w1'],
        items: [{ itemId: SEG, itemVersion: 2 }],
      },
    ],
    policyVersion: 'pv-1',
    noticeIds: [n.noticeId],
    notices: [n],
    occurredAt: '2026-10-07T09:15:00.000Z',
    ...overrides,
  };
}

interface ItemRow {
  id: string;
  tenantId: string;
  consultationId: string;
  currentVersionNumber: number;
  guardrailStatus?: string;
}

function makeHarness(
  opts: {
    existingIds?: string[];
    items?: ItemRow[];
    status?: ConsultationStatus;
    storedNotice?: (entity: { id: string; status: string }) => { id: string; status: string } | null;
  } = {},
) {
  const order: string[] = [];
  const evaluations = {
    findAll: vi.fn(async () => (opts.existingIds ?? []).map((id) => ({ id }))),
    createManyIdempotent: vi.fn(async (entities: unknown[], tx?: unknown) => {
      order.push(`evaluations.create@${String(tx)}`);
      return { inserted: entities.length, duplicates: 0 };
    }),
  };
  const notices = {
    upsertByDedupeKey: vi.fn(async (entity: { id: string; status: string }, tx?: unknown) => {
      order.push(`notice.upsert@${String(tx)}`);
      const stored = opts.storedNotice?.(entity) ?? null;
      return stored ? { notice: stored, created: false } : { notice: entity, created: true };
    }),
  };
  const contextItems = {
    findAll: vi.fn(async () => opts.items ?? [{ id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 2 }]),
    setGuardrailStatusMany: vi.fn(async (ids: string[], _status: string, tx?: unknown) => {
      order.push(`mark@${String(tx)}`);
      return ids.length;
    }),
  };
  const row = {
    id: CONSULTATION,
    tenantId: TENANT,
    status: opts.status ?? ConsultationStatus.RECORDING,
    processing: ConsultationProcessing.IDLE,
    processingReason: null,
    closedReason: null,
    currentEncounterSeq: 1,
    version: 4,
  };
  const consultations = {
    findByIdOrNull: vi.fn(async () => ({ ...row })),
    setProcessing: vi.fn(async (_id: string, _p: string, _o: unknown, tx?: unknown) => {
      order.push(`processing@${String(tx)}`);
      return true;
    }),
  };
  const unitOfWork = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push('tx.begin');
      const result = await work('tx');
      order.push('tx.commit');
      return result;
    }),
  };
  const events = { publish: vi.fn(async () => (order.push('event'), {})) };
  const lifecycle = { pause: vi.fn(async () => (order.push('pause'), {})) };
  const secrets = { encrypt: vi.fn(async () => 'vault:v3:Y2lwaGVy'), decrypt: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn(), run: vi.fn((fn: () => unknown) => fn()) };
  // The ONE hold-entry path, real, over the same mocks (round 3: the ingest delegates to it).
  const holds = new GuardrailHoldService(consultations as never, notices as never, eventEmitter as never, cls as never, undefined, events as never, lifecycle as never);
  const service = new GuardrailEvaluationIngestService(
    evaluations as never,
    notices as never,
    contextItems as never,
    eventEmitter as never,
    cls as never,
    unitOfWork as never,
    holds,
    secrets as never,
  );
  return { service, evaluations, notices, contextItems, consultations, unitOfWork, events, lifecycle, secrets, eventEmitter, order };
}

describe('GuardrailEvaluationIngestService.ingest — validation', () => {
  it('refuses a record whose tenantId differs from X-Tenant-Id (400), writing nothing', async () => {
    const h = makeHarness();
    await expect(h.service.ingest(TENANT, { evaluations: [record({ tenantId: 'other-tenant' })] })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.unitOfWork.runInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an empty batch and one larger than 100 records (400)', async () => {
    const h = makeHarness();
    await expect(h.service.ingest(TENANT, { evaluations: [] })).rejects.toBeInstanceOf(BadRequestException);
    const many = Array.from({ length: 101 }, (_, i) => record({ evaluationId: `e-${i}` }));
    await expect(h.service.ingest(TENANT, { evaluations: many })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GuardrailEvaluationIngestService.ingest — persistence', () => {
  it('writes the evaluations, notices and markers in ONE transaction and answers accepted/duplicates', async () => {
    const h = makeHarness();
    const result = await h.service.ingest(TENANT, { evaluations: [record()] });

    expect(result).toEqual({ accepted: 1, duplicates: 0 });
    expect(h.order).toEqual(['tx.begin', 'notice.upsert@tx', 'evaluations.create@tx', 'mark@tx', 'tx.commit']);
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(entities[0]).toMatchObject({ id: record().evaluationId, direction: 'INBOUND', decision: 'WARN', caller: 'harness.guardrail_check' });
    expect((entities[0] as { noticeIds: string[] }).noticeIds).toEqual([notice().noticeId]);
    expect((entities[0] as { at: Date }).at.toISOString()).toBe('2026-10-07T09:15:00.000Z');
    // The notice keeps guardrail's id: clients address it by the id the run stream carried.
    const [stored] = h.notices.upsertByDedupeKey.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(stored).toMatchObject({ id: notice().noticeId, type: 'WARNING', direction: 'INBOUND', status: 'OPEN', messageKey: 'guardrail.warning.generic' });
    // Guardrail mints a DETERMINISTIC noticeId (sha256(tenantId|dedupeKey)): the upsert is keyed on it.
    expect(stored.dedupeKey).toBe(notice().noticeId);
  });

  it('is idempotent on redrive: an evaluation already stored is a duplicate and drives nothing', async () => {
    const h = makeHarness({ existingIds: [record().evaluationId] });
    const result = await h.service.ingest(TENANT, { evaluations: [record()] });
    expect(result).toEqual({ accepted: 0, duplicates: 1 });
    expect(h.notices.upsertByDedupeKey).not.toHaveBeenCalled();
    expect(h.contextItems.setGuardrailStatusMany).not.toHaveBeenCalled();
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
  });

  it('counts a repeated evaluationId inside one batch once', async () => {
    const h = makeHarness();
    const result = await h.service.ingest(TENANT, { evaluations: [record(), record()] });
    expect(result).toEqual({ accepted: 1, duplicates: 1 });
  });

  it('never collapses notices that carry different ids, even with the same checks and items', async () => {
    const h = makeHarness();
    const a = notice();
    const b = notice({ noticeId: '01927f6e-9999-7000-8000-0000000000cc' });
    await h.service.ingest(TENANT, { evaluations: [record({ noticeIds: [a.noticeId, b.noticeId], notices: [a, b] })] });
    const keys = h.notices.upsertByDedupeKey.mock.calls.map(([entity]) => [(entity as { id: string }).id, (entity as { dedupeKey: string }).dedupeKey]);
    expect(keys).toEqual([
      [a.noticeId, a.noticeId],
      [b.noticeId, b.noticeId],
    ]);
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<{ noticeIds: string[] }>];
    expect(entities[0].noticeIds).toEqual([a.noticeId, b.noticeId]);
  });

  it('a re-raise arrives with the same id and is a no-op on the stored notice', async () => {
    const h = makeHarness({ storedNotice: (entity) => ({ id: entity.id, status: 'ACKNOWLEDGED' }) });
    await h.service.ingest(TENANT, { evaluations: [record()] });
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<{ noticeIds: string[] }>];
    expect(entities[0].noticeIds).toEqual([notice().noticeId]);
    const created = h.eventEmitter.emit.mock.calls.map(([, p]) => p as { data?: { action?: string } }).filter((p) => p.data?.action === 'guardrail_notice_raised');
    expect(created).toHaveLength(0);
  });

  it('accepts a TEXT- or harness-minted notice (its own id, no checks) the same way', async () => {
    const h = makeHarness();
    const n = blockNotice({ noticeId: 'text-minted-redaction-1', checks: [], messageKey: 'guardrail.blocked.redaction_unavailable', direction: 'outbound' });
    await h.service.ingest(TENANT, { evaluations: [record({ direction: 'outbound', decision: 'block', checks: [], noticeIds: [n.noticeId], notices: [n] })] });
    const [stored] = h.notices.upsertByDedupeKey.mock.calls[0] as unknown as [{ id: string; dedupeKey: string }];
    expect([stored.id, stored.dedupeKey]).toEqual(['text-minted-redaction-1', 'text-minted-redaction-1']);
  });

  it('broadcasts a sys-event for the stored evaluations (ids and counts only)', async () => {
    const h = makeHarness();
    await h.service.ingest(TENANT, { evaluations: [record()] });
    const payloads = h.eventEmitter.emit.mock.calls.map(([, payload]) => payload as { resourceType?: string; data?: Record<string, unknown> });
    expect(payloads.some((p) => p.resourceType === 'GuardrailEvaluation' && p.data?.count === 1)).toBe(true);
    expect(JSON.stringify(payloads)).not.toContain('withheld');
  });
});

describe('GuardrailEvaluationIngestService.ingest — item marking', () => {
  it('marks a warned item WARNED when the screened version is current', async () => {
    const h = makeHarness();
    await h.service.ingest(TENANT, { evaluations: [record()] });
    expect(h.contextItems.setGuardrailStatusMany).toHaveBeenCalledWith([SEG], GuardrailItemStatus.WARNED, 'tx');
  });

  it('skips an item whose current version is newer than the screened one (the edit is re-screened)', async () => {
    const h = makeHarness({ items: [{ id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 3 }] });
    await h.service.ingest(TENANT, { evaluations: [record()] });
    expect(h.contextItems.setGuardrailStatusMany).not.toHaveBeenCalled();
  });

  it('never downgrades a marker (a BLOCKED item stays BLOCKED on a later warn)', async () => {
    const h = makeHarness({
      items: [{ id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 2, guardrailStatus: GuardrailItemStatus.BLOCKED }],
    });
    await h.service.ingest(TENANT, { evaluations: [record()] });
    expect(h.contextItems.setGuardrailStatusMany).not.toHaveBeenCalled();
  });

  it('never marks another tenant`s or another consultation`s item', async () => {
    const h = makeHarness({
      items: [
        { id: SEG, tenantId: 'other', consultationId: CONSULTATION, currentVersionNumber: 2 },
        { id: SEG2, tenantId: TENANT, consultationId: 'other-consultation', currentVersionNumber: 1 },
      ],
    });
    const r = record();
    await h.service.ingest(TENANT, {
      evaluations: [record({ checks: [{ ...r.checks[0], items: [{ itemId: SEG, itemVersion: 2 }, { itemId: SEG2, itemVersion: 1 }] }] })],
    });
    expect(h.contextItems.setGuardrailStatusMany).not.toHaveBeenCalled();
  });

  it('marks only the items the check`s notice names — a block on the system region marks no transcript item (e2e S1)', async () => {
    const h = makeHarness({
      items: [
        { id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 2 },
        { id: SEG2, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 1 },
      ],
    });
    const r = record();
    const systemBlock = blockNotice({ checks: [{ checkId: 'jailbreak_detection', category: 'MALICIOUS', severity: 'high' }], itemIds: [] });
    const segBlock = blockNotice({
      noticeId: '01927f6e-9999-7000-8000-0000000000cc',
      checks: [{ checkId: 'prompt_safety', category: 'unsafe', severity: 'high' }],
      itemIds: [SEG2],
    });
    const covered = [{ itemId: SEG, itemVersion: 2 }, { itemId: SEG2, itemVersion: 1 }];
    await h.service.ingest(TENANT, {
      evaluations: [
        record({
          decision: 'block',
          noticeIds: [systemBlock.noticeId, segBlock.noticeId],
          notices: [systemBlock, segBlock],
          checks: [
            { ...r.checks[0], checkId: 'jailbreak_detection', actionTaken: 'block', regionKeys: ['system', 'transcript'], items: covered },
            { ...r.checks[0], checkId: 'prompt_safety', actionTaken: 'block', regionKeys: ['system', 'transcript'], items: covered },
          ],
        }),
      ],
    });
    expect(h.contextItems.setGuardrailStatusMany.mock.calls.map(([ids, status]) => [ids, status])).toEqual([[[SEG2], GuardrailItemStatus.BLOCKED]]);
  });

  it('marks the source items of an inbound block BLOCKED, the strongest action per item', async () => {
    const h = makeHarness({
      items: [
        { id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 2 },
        { id: SEG2, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 1 },
      ],
    });
    const b = blockNotice();
    const r = record();
    await h.service.ingest(TENANT, {
      evaluations: [
        record({
          decision: 'block',
          noticeIds: [b.noticeId],
          notices: [b],
          checks: [
            { ...r.checks[0], items: [{ itemId: SEG, itemVersion: 2 }, { itemId: SEG2, itemVersion: 1 }] },
            { ...r.checks[0], checkId: 'injection_judge', actionTaken: 'block', items: [{ itemId: SEG, itemVersion: 2 }] },
          ],
        }),
      ],
    });
    const calls = h.contextItems.setGuardrailStatusMany.mock.calls.map(([ids, status]) => [ids, status]);
    expect(calls).toEqual(
      expect.arrayContaining([
        [[SEG], GuardrailItemStatus.BLOCKED],
        [[SEG2], GuardrailItemStatus.WARNED],
      ]),
    );
  });
});

describe('GuardrailEvaluationIngestService.ingest — guardrail hold', () => {
  function blockRecord(n: GuardrailNotice = blockNotice()): GuardrailEvaluationRecord {
    const r = record();
    return record({
      decision: 'block',
      noticeIds: [n.noticeId],
      notices: [n],
      checks: [{ ...r.checks[0], checkId: 'injection_judge', actionTaken: 'block' }],
    });
  }

  it('enters the hold on a live consultation: AWAITING_REVIEW / GUARDRAIL_HOLD in the transaction, capture paused, state-only event with the notice pointer', async () => {
    const h = makeHarness({ status: ConsultationStatus.RECORDING });
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });

    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.AWAITING_REVIEW, { reason: 'GUARDRAIL_HOLD' }, 'tx');
    expect(h.order.indexOf('processing@tx')).toBeLessThan(h.order.indexOf('tx.commit'));
    expect(h.lifecycle.pause).toHaveBeenCalledWith(CONSULTATION, { reason: 'guardrail_hold' });
    expect(h.order.indexOf('pause')).toBeGreaterThan(h.order.indexOf('tx.commit'));
    const [subject, type, extras] = h.events.publish.mock.calls.at(-1) as unknown as [Record<string, unknown>, string, Record<string, unknown>];
    expect(type).toBe('processing_changed');
    expect(subject).toMatchObject({ processing: ConsultationProcessing.AWAITING_REVIEW, processingReason: 'GUARDRAIL_HOLD' });
    expect(extras).toMatchObject({ noticeId: blockNotice().noticeId });
  });

  it('does not pause a consultation that is not recording (a STOPPED one is held in place)', async () => {
    const h = makeHarness({ status: ConsultationStatus.STOPPED });
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(h.consultations.setProcessing).toHaveBeenCalled();
    expect(h.lifecycle.pause).not.toHaveBeenCalled();
  });

  it('holds with EGRESS_REDACTION_UNAVAILABLE for the cloud-egress privacy hold', async () => {
    const h = makeHarness();
    const n = blockNotice({ messageKey: 'guardrail.blocked.redaction_unavailable', checks: [], direction: 'outbound' });
    await h.service.ingest(TENANT, { evaluations: [{ ...blockRecord(n), direction: 'outbound', checks: [] }] });
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(
      CONSULTATION,
      ConsultationProcessing.AWAITING_REVIEW,
      { reason: 'EGRESS_REDACTION_UNAVAILABLE' },
      'tx',
    );
  });

  it('never holds an approved or closed consultation (the record stands, nothing moves)', async () => {
    for (const status of [ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE]) {
      const h = makeHarness({ status });
      await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
      expect(h.consultations.setProcessing).not.toHaveBeenCalled();
      expect(h.lifecycle.pause).not.toHaveBeenCalled();
    }
  });

  it('does not hold again for a notice id already stored (entered earlier by the run watcher)', async () => {
    const h = makeHarness({ storedNotice: () => ({ id: blockNotice().noticeId, status: GuardrailNoticeStatus.OPEN }) });
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(h.lifecycle.pause).not.toHaveBeenCalled();
  });

  it('does not re-hold on a block whose deduped notice the clinician already resolved', async () => {
    const h = makeHarness({ storedNotice: () => ({ id: blockNotice().noticeId, status: GuardrailNoticeStatus.RESOLVED }) });
    await h.service.ingest(TENANT, { evaluations: [blockRecord()] });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
  });

  it('does not hold on a warn', async () => {
    const h = makeHarness();
    await h.service.ingest(TENANT, { evaluations: [record()] });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
  });
});

describe('GuardrailEvaluationIngestService.ingest — withheld output', () => {
  it('encrypts the withheld text of an OUTBOUND BLOCK (Transit) and stores only ciphertext + key version', async () => {
    const h = makeHarness();
    const n = blockNotice({ direction: 'outbound', messageKey: 'guardrail.blocked.outbound', defaultMessage: 'A safety check withheld the generated content. Review it to continue.' });
    const r = record();
    await h.service.ingest(TENANT, {
      evaluations: [
        record({
          direction: 'outbound',
          decision: 'block',
          noticeIds: [n.noticeId],
          notices: [n],
          checks: [{ ...r.checks[0], checkId: 'leakage_judge', actionTaken: 'block', items: [] }],
          withheldContent: 'the withheld note',
        }),
      ],
    });
    expect(h.secrets.encrypt).toHaveBeenCalledTimes(1);
    expect((h.secrets.encrypt.mock.calls[0] as unknown as [Buffer])[0].toString('utf8')).toBe('the withheld note');
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(Buffer.isBuffer(entities[0].encryptedWithheldContent)).toBe(true);
    expect(String(entities[0].encryptedWithheldContent)).toBe('vault:v3:Y2lwaGVy');
    expect(entities[0].keyVersion).toBe(3);
    expect(JSON.stringify(entities[0])).not.toContain('the withheld note');
  });

  it('drops withheld text on anything but an outbound block (never stored, never encrypted)', async () => {
    const h = makeHarness();
    await h.service.ingest(TENANT, { evaluations: [record({ withheldContent: 'should not be kept' })] });
    expect(h.secrets.encrypt).not.toHaveBeenCalled();
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(entities[0].encryptedWithheldContent ?? null).toBeNull();
  });
});

describe('GuardrailEvaluationIngestService.ingest — check reason', () => {
  it('stores a check`s `reason` on the evaluation row', async () => {
    const h = makeHarness();
    const base = record();
    const checks = [{ ...base.checks[0], verdict: 'skipped', actionTaken: 'none', reason: 'not_selected_for_tenant' }] as never;
    await h.service.ingest(TENANT, { evaluations: [record({ checks, notices: [], noticeIds: [], decision: 'allow' })] });
    const [entities] = h.evaluations.createManyIdempotent.mock.calls[0] as unknown as [Array<{ checks: Array<{ reason?: string }> }>];
    expect(entities[0].checks[0].reason).toBe('not_selected_for_tenant');
  });
});

describe('GuardrailEvaluationIngestService.ingest — one notice listing three checks (E)', () => {
  it('stores ONE notice with all three checks, enters ONE hold, and marks the items every check flagged', async () => {
    const checks = [
      { checkId: 'injection_judge', category: 'instruction_override', severity: 'high' },
      { checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' },
      { checkId: 'leakage_judge', category: 'secret', severity: 'low' },
    ] as GuardrailNotice['checks'];
    const n = blockNotice({ checks, itemIds: [SEG, SEG2] });
    const base = record().checks[0];
    const evalChecks = checks.map((one, index) => ({
      ...base,
      checkId: one.checkId,
      actionTaken: 'block' as const,
      items: index === 2 ? [{ itemId: SEG2, itemVersion: 1 }] : [{ itemId: SEG, itemVersion: 2 }],
    }));
    const h2 = makeHarness({
      items: [
        { id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 2 },
        { id: SEG2, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 1 },
      ],
    });
    await h2.service.ingest(TENANT, { evaluations: [record({ decision: 'block', checks: evalChecks, noticeIds: [n.noticeId], notices: [n] })] });

    expect(h2.notices.upsertByDedupeKey).toHaveBeenCalledTimes(1);
    const [stored] = h2.notices.upsertByDedupeKey.mock.calls[0] as unknown as [{ checks: Array<{ checkId: string }>; severity: string }];
    expect(stored.checks.map((check) => check.checkId)).toEqual(['injection_judge', 'unsafe_content_judge', 'leakage_judge']);
    expect(stored.severity).toBe('high');
    expect(h2.consultations.setProcessing).toHaveBeenCalledTimes(1);
    const marked = h2.contextItems.setGuardrailStatusMany.mock.calls.flatMap(([ids]) => ids as string[]).sort();
    expect(marked).toEqual([SEG, SEG2].sort());
  });
});
