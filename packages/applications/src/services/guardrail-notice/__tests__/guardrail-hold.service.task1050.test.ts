/**
 * TASK-1050 W2e round 3 — `GuardrailHoldService.enterGuardrailHold`: the ONE way a consultation
 * enters a guardrail hold when no evaluation record carries it — TEXT's egress-redaction hold (its
 * inbound screen is down, so nothing was evaluated) and a harness run that paused on a block whose
 * evaluation has not been drained yet. The evaluation ingest uses the same service.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GuardrailNotice } from '@arcaai/types';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./support/w0-domains')),
}));

import { ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';
import { GuardrailHoldService } from '../guardrail-hold.service';

const TENANT = 'tenant-1';
const CID = 'c-1';

function blocked(overrides: Partial<GuardrailNotice> = {}): GuardrailNotice {
  return {
    schemaVersion: 1,
    noticeId: 'notice-1',
    type: 'guardrail.blocked',
    direction: 'inbound',
    action: 'block',
    checks: [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }],
    consultationId: CID,
    runId: 'run-1',
    nodeId: 'n_note',
    itemIds: ['seg-1'],
    messageKey: 'guardrail.blocked.inbound',
    defaultMessage: 'A safety check stopped this request. Review the flagged input to continue.',
    requiresAcknowledgement: true,
    resumable: true,
    policyVersion: 'pv-1',
    occurredAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  };
}

function makeHarness(opts: { status?: ConsultationStatus; existing?: boolean; tenantId?: string } = {}) {
  const order: string[] = [];
  const row = {
    id: CID,
    tenantId: opts.tenantId ?? TENANT,
    status: opts.status ?? ConsultationStatus.RECORDING,
    processing: ConsultationProcessing.IDLE,
    processingReason: null,
    closedReason: null,
    currentEncounterSeq: 1,
    version: 4,
  };
  const consultations = {
    findByIdOrNull: vi.fn(async () => ({ ...row })),
    setProcessing: vi.fn(async (_id: string, _p: string, _o: unknown, tx?: unknown) => (order.push(`processing@${String(tx)}`), true)),
  };
  const notices = {
    upsertByDedupeKey: vi.fn(async (entity: { id: string }, tx?: unknown) => {
      order.push(`notice.upsert@${String(tx)}`);
      return { notice: entity, created: !opts.existing };
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
  const lifecycle = { pause: vi.fn(async () => (order.push('pause'), { status: 'PAUSED', version: 5 })) };
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn(async (fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
  const eventEmitter = { emit: vi.fn() };
  const service = new GuardrailHoldService(
    consultations as never,
    notices as never,
    eventEmitter as never,
    cls as never,
    unitOfWork as never,
    events as never,
    lifecycle as never,
  );
  return { service, consultations, notices, events, lifecycle, cls, store, order };
}

describe('GuardrailHoldService.enterGuardrailHold', () => {
  it('upserts the notice by its id and enters GUARDRAIL_HOLD in one transaction, then pauses capture and emits the state-only event', async () => {
    const h = makeHarness();
    const entry = await h.service.enterGuardrailHold(TENANT, CID, blocked());

    expect(entry).toMatchObject({ consultationId: CID, noticeId: 'notice-1', reason: 'GUARDRAIL_HOLD' });
    const [stored] = h.notices.upsertByDedupeKey.mock.calls[0] as unknown as [{ id: string; dedupeKey: string; type: string }];
    expect([stored.id, stored.dedupeKey, stored.type]).toEqual(['notice-1', 'notice-1', 'BLOCKED']);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, { reason: 'GUARDRAIL_HOLD' }, 'tx');
    expect(h.order).toEqual(['tx.begin', 'notice.upsert@tx', 'processing@tx', 'tx.commit', 'pause', 'event']);
    expect(h.lifecycle.pause).toHaveBeenCalledWith(CID, { reason: 'guardrail_hold' });
    const [subject, type, extras] = h.events.publish.mock.calls[0] as unknown as [Record<string, unknown>, string, Record<string, unknown>];
    expect(type).toBe('processing_changed');
    expect(subject).toMatchObject({ status: 'PAUSED', version: 5, processing: ConsultationProcessing.AWAITING_REVIEW, processingReason: 'GUARDRAIL_HOLD' });
    expect(extras).toEqual({ noticeId: 'notice-1' });
  });

  it('holds with EGRESS_REDACTION_UNAVAILABLE for the redaction-unavailable notice (no checks)', async () => {
    const h = makeHarness({ status: ConsultationStatus.STOPPED });
    const entry = await h.service.enterGuardrailHold(
      TENANT,
      CID,
      blocked({ noticeId: 'text-redaction-1', messageKey: 'guardrail.blocked.redaction_unavailable', checks: [], direction: 'outbound' }),
    );
    expect(entry?.reason).toBe('EGRESS_REDACTION_UNAVAILABLE');
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CID, ConsultationProcessing.AWAITING_REVIEW, { reason: 'EGRESS_REDACTION_UNAVAILABLE' }, 'tx');
    // A STOPPED consultation is held in place: nothing to pause.
    expect(h.lifecycle.pause).not.toHaveBeenCalled();
  });

  it('is idempotent: a notice id already stored is a no-op (no processing write, no pause, no event)', async () => {
    const h = makeHarness({ existing: true });
    expect(await h.service.enterGuardrailHold(TENANT, CID, blocked())).toBeNull();
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(h.lifecycle.pause).not.toHaveBeenCalled();
    expect(h.events.publish).not.toHaveBeenCalled();
  });

  it('refuses an approved or closed consultation silently (null, nothing written beyond the notice)', async () => {
    for (const status of [ConsultationStatus.APPROVED, ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.CLOSED_INCOMPLETE]) {
      const h = makeHarness({ status });
      await expect(h.service.enterGuardrailHold(TENANT, CID, blocked())).resolves.toBeNull();
      expect(h.consultations.setProcessing).not.toHaveBeenCalled();
      expect(h.lifecycle.pause).not.toHaveBeenCalled();
    }
  });

  it('never holds another tenant`s consultation, and ignores a notice that is not a block', async () => {
    const foreign = makeHarness({ tenantId: 'tenant-2' });
    expect(await foreign.service.enterGuardrailHold(TENANT, CID, blocked())).toBeNull();
    expect(foreign.consultations.setProcessing).not.toHaveBeenCalled();

    const warn = makeHarness();
    expect(await warn.service.enterGuardrailHold(TENANT, CID, blocked({ type: 'guardrail.warning', action: 'warn', resumable: false }))).toBeNull();
    expect(warn.notices.upsertByDedupeKey).not.toHaveBeenCalled();
  });

  it('runs under a CLS context pinned to the tenant (callers such as the run watcher carry none)', async () => {
    const h = makeHarness();
    await h.service.enterGuardrailHold(TENANT, CID, blocked());
    expect(h.cls.run).toHaveBeenCalled();
    expect(h.store.get('tenantId')).toBe(TENANT);
  });

  it('never throws: a failed write is logged and answers null', async () => {
    const h = makeHarness();
    h.notices.upsertByDedupeKey.mockRejectedValueOnce(new Error('db down'));
    await expect(h.service.enterGuardrailHold(TENANT, CID, blocked())).resolves.toBeNull();
  });
});
