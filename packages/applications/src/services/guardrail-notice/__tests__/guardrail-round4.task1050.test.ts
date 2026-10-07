/**
 * TASK-1050 W2e round 4 —
 *  1. resuming an EGRESS_REDACTION_UNAVAILABLE hold: `acknowledged` means RETRY — no
 *     SAFETY_OVERRIDE (a plain, audited resume sys-event instead), the run signal unchanged; the
 *     item resolutions are 409 (there is no item to exclude or edit);
 *  2. the admin evaluation list filters by `runId` / `runKey`;
 *  3. activity item entries carry `guardrailStatus`;
 *  4. approve with `resolveHold` on an inbound hold answers the consultation + `acknowledgedNotices`.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./support/w0-domains')),
}));

import {
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ContextItemSource,
  ContextItemType,
  GuardrailDirection,
  GuardrailNoticeFactory,
  GuardrailNoticeStatus,
  GuardrailNoticeType,
  HarnessAuditAction,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { GuardrailNoticeService } from '../guardrail-notice.service';
import { GuardrailEvaluationAdminService } from '../../guardrail-evaluation/guardrail-evaluation-admin.service';
import { ConsultationHistoryService } from '../../consultation/history/consultation-history.service';
import { ConsultationApprovalService } from '../../consultation/lifecycle/consultation-approval.service';
import { ConsultationLifecycleEventPublisher } from '../../consultation/lifecycle/lifecycle-event.publisher';

const TENANT = 'tenant-1';
const CID = 'c-1';
const DOCTOR = 'doctor-1';

function notice(type: GuardrailNoticeType, overrides: { messageKey?: string; checks?: unknown[]; direction?: GuardrailDirection } = {}): GuardrailNoticeEntity {
  const block = type === GuardrailNoticeType.BLOCKED;
  return GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: TENANT,
    consultationId: CID,
    runId: 'run-1',
    type,
    direction: overrides.direction ?? GuardrailDirection.INBOUND,
    action: block ? 'block' : 'warn',
    checks: (overrides.checks ?? [{ checkId: 'injection_judge', severity: 'high' }]) as never,
    itemIds: overrides.checks && (overrides.checks as unknown[]).length === 0 ? [] : ['seg-1'],
    messageKey: overrides.messageKey ?? (block ? 'guardrail.blocked.inbound' : 'guardrail.warning.generic'),
    severity: 'high',
    requiresAcknowledgement: true,
    resumable: block,
    policyVersion: 'pv-1',
    dedupeKey: `dk-${Math.random()}`,
  });
}

const redaction = () =>
  notice(GuardrailNoticeType.BLOCKED, { messageKey: 'guardrail.blocked.redaction_unavailable', checks: [], direction: GuardrailDirection.OUTBOUND });

function consultationRow(overrides: Record<string, unknown> = {}) {
  return new ConsultationEntity({
    id: CID,
    tenantId: TENANT,
    patientId: 'p-1',
    doctorId: DOCTOR,
    appointmentDate: new Date('2026-10-07'),
    status: ConsultationStatus.PAUSED,
    processing: ConsultationProcessing.AWAITING_REVIEW,
    processingReason: 'EGRESS_REDACTION_UNAVAILABLE',
    currentEncounterSeq: 1,
    version: 7,
    createdAt: new Date('2026-10-07'),
    updatedAt: new Date('2026-10-07'),
    ...overrides,
  } as never);
}

function noticeService(target: GuardrailNoticeEntity) {
  const order: string[] = [];
  const consultations = {
    findByIdOrNull: vi.fn(async () => consultationRow()),
    setProcessing: vi.fn(async () => (order.push('processing'), true)),
  };
  const notices = {
    findByIdOrNull: vi.fn(async (id: string) => (id === target.id ? target : null)),
    findAll: vi.fn(async () => []),
    updateWithVersion: vi.fn(async (_id: string, entity: GuardrailNoticeEntity) => (order.push('notice.cas'), entity)),
  };
  const audit = { append: vi.fn(async () => ({})) };
  const gateway = { signalGuardrailResolution: vi.fn(async () => ({ signaled: true })) };
  const dispatch = { supersedeGoverningRun: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)), set: vi.fn() };
  const service = new GuardrailNoticeService(
    consultations as never,
    notices as never,
    { findByConsultation: vi.fn(async () => []) } as never,
    { findAll: vi.fn(async () => []), setGuardrailStatusMany: vi.fn() } as never,
    eventEmitter as never,
    cls as never,
    undefined,
    { publish: vi.fn(async () => ({})) } as never,
    audit as never,
    gateway as never,
    dispatch as never,
  );
  return { service, audit, gateway, dispatch, eventEmitter, consultations };
}

const human = { userId: DOCTOR, isMachine: false };

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return ((error as ConflictException).getResponse() as { code?: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('resume of an EGRESS_REDACTION_UNAVAILABLE hold', () => {
  it('acknowledged = RETRY: no SAFETY_OVERRIDE, an audited resume sys-event, the run signalled as for any resume', async () => {
    const target = redaction();
    const h = noticeService(target);
    const result = await h.service.resumeHold(CID, { noticeId: target.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });

    expect(h.audit.append).not.toHaveBeenCalled();
    expect(h.audit.append.mock.calls.some(([input]) => (input as { action?: string })?.action === HarnessAuditAction.SAFETY_OVERRIDE)).toBe(false);
    const events = h.eventEmitter.emit.mock.calls.map(([, p]) => p as { forceAuditLog?: boolean; data?: Record<string, unknown> });
    expect(events.some((p) => p.forceAuditLog && p.data?.action === 'guardrail_hold_retried' && p.data?.processingReason === 'EGRESS_REDACTION_UNAVAILABLE')).toBe(true);
    expect(h.gateway.signalGuardrailResolution).toHaveBeenCalledWith('run-1', { noticeId: target.id, resolution: 'acknowledged', by: DOCTOR }, TENANT);
    expect(target.status).toBe(GuardrailNoticeStatus.RESOLVED);
    expect(result.resolvedNoticeId).toBe(target.id);
  });

  it('refuses item_excluded and item_edited (409 GUARDRAIL_RESOLUTION_NOT_APPLICABLE): there is no item', async () => {
    for (const resolution of ['item_excluded', 'item_edited'] as const) {
      const target = redaction();
      const h = noticeService(target);
      expect(await codeOf(h.service.resumeHold(CID, { noticeId: target.id, resolution }, { expectedVersion: 7, caller: human }))).toBe(
        'GUARDRAIL_RESOLUTION_NOT_APPLICABLE',
      );
      expect(target.status).toBe(GuardrailNoticeStatus.OPEN);
    }
  });

  it('a safety block acknowledged is still a SAFETY_OVERRIDE (unchanged)', async () => {
    const target = notice(GuardrailNoticeType.BLOCKED);
    const h = noticeService(target);
    await h.service.resumeHold(CID, { noticeId: target.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: HarnessAuditAction.SAFETY_OVERRIDE }));
  });
});

describe('admin evaluation list — run filters', () => {
  it('filters by runId and runKey', async () => {
    const evaluations = { findAll: vi.fn(async () => []), findByIdOrNull: vi.fn(), count: vi.fn() };
    const service = new GuardrailEvaluationAdminService(
      { findByIdOrNull: vi.fn(async () => ({ id: CID, tenantId: TENANT })) } as never,
      evaluations as never,
      { count: vi.fn() } as never,
      { emit: vi.fn() } as never,
      { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    );
    await service.list(CID, { runId: 'run-7', runKey: 'scribe:c-1:3' });
    const [args] = evaluations.findAll.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where).toMatchObject({ tenantId: TENANT, consultationId: CID, runId: 'run-7', runKey: 'scribe:c-1:3' });
  });
});

describe('activity item entries — guardrailStatus', () => {
  it('every item carries its marker (CLEAN when unmarked), read once per page for the marked ones', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 9, 0, s));
    const row = (id: string, s: number) => ({
      id,
      type: ContextItemType.CASE_NOTE,
      source: ContextItemSource.USER,
      encounterSeq: 1,
      segmentSeq: null,
      speaker: null,
      t0Ms: null,
      t1Ms: null,
      occurredAt: at(s),
      currentVersionNumber: 1,
      mediaId: null,
      createdBy: DOCTOR,
      createdAt: at(s),
    });
    const contextItems = { findAll: vi.fn(async () => [{ id: 'n-2', guardrailStatus: 'BLOCKED' }]) };
    const service = new ConsultationHistoryService(
      { findByIdOrNull: vi.fn(async () => ({ id: CID, tenantId: TENANT, status: 'STOPPED', processing: 'IDLE', closedAt: null })) } as never,
      { findByConsultation: vi.fn(async () => []) } as never,
      { findByConsultation: vi.fn(async () => []) } as never,
      contextItems as never,
      {} as never,
      {
        pageItems: vi.fn(async (input: { after: unknown }) => (input.after ? [] : [row('n-1', 1), row('n-2', 2)])),
        countEditedItems: vi.fn(async () => 0),
        listLifecycleEvents: vi.fn(async () => []),
        listVersionMeta: vi.fn(async () => []),
        readContents: vi.fn(async () => new Map()),
      } as never,
      { emit: vi.fn() } as never,
      { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'sa', roles: ['SUPER_ADMIN'] } : undefined)) } as never,
    );
    const page = await service.getActivity(CID, { kinds: ['CASE_NOTE'] as never }, { admin: true });
    const items = page.items.filter((entry) => entry.entryType === 'item') as Array<{ id: string; guardrailStatus?: string }>;
    expect(items.map((item) => [item.id, item.guardrailStatus])).toEqual([
      ['n-1', 'CLEAN'],
      ['n-2', 'BLOCKED'],
    ]);
    expect(contextItems.findAll).toHaveBeenCalledTimes(1);
    expect(contextItems.findAll).toHaveBeenCalledWith({ where: { id: { in: ['n-1', 'n-2'] }, guardrailStatus: { not: 'CLEAN' } } });
  });
});

describe('approve with resolveHold on an inbound hold — the response the console reads', () => {
  it('answers the approved consultation plus acknowledgedNotices (the warnings); the resolved hold is in the snapshot', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED);
    const warning = notice(GuardrailNoticeType.WARNING);
    let current = consultationRow({ status: ConsultationStatus.STOPPED, processingReason: 'GUARDRAIL_HOLD' });
    const approvals = { create: vi.fn(async (a: unknown) => a) };
    const eventEmitter = { emit: vi.fn() };
    const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)), set: vi.fn() };
    const service = new ConsultationApprovalService(
      { findByIdOrNull: vi.fn(async () => current), updateWithVersion: vi.fn(async (_i: string, e: ConsultationEntity) => (current = e)) } as never,
      { findByConsultation: vi.fn(async () => []), findByIdOrNull: vi.fn(), updateWithVersion: vi.fn() } as never,
      { create: vi.fn() } as never,
      { findByConsultation: vi.fn(async () => [{ seq: 1 }]) } as never,
      approvals as never,
      { append: vi.fn(async () => ({})) } as never,
      {
        prepareSessionSignature: vi.fn(async () => ({ approvedBy: DOCTOR, actor: { credentialClass: 'jwt', principalId: DOCTOR }, note: null })),
        afterSessionSigned: vi.fn(),
      } as never,
      new ConsultationLifecycleEventPublisher(eventEmitter as never, cls as never, undefined, undefined),
      eventEmitter as never,
      cls as never,
      { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as never,
      undefined,
      { findAll: vi.fn(async () => [block, warning]), updateWithVersion: vi.fn(async (_i: string, e: unknown) => e) } as never,
    );

    const response = await service.approve(CID, { expectedVersion: 7, caller: human, resolveHold: { noticeId: block.id, resolution: 'item_excluded' } });

    expect(response).toMatchObject({ id: CID, status: 'APPROVED', processing: ConsultationProcessing.IDLE });
    expect(response.acknowledgedNotices).toEqual([
      { noticeId: warning.id, acknowledgedBy: DOCTOR, acknowledgedVia: 'approve', acknowledgedAt: expect.any(String) },
    ]);
    const [approval] = approvals.create.mock.calls[0] as unknown as [{ snapshot: { guardrailNotices: string[] } }];
    expect(approval.snapshot.guardrailNotices).toEqual([block.id, warning.id].sort());
    expect(block.resolution).toBe('item_excluded');
  });
});
