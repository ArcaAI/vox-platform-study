/**
 * TASK-1059 lane O (TASK-1058 RC-8 / E1-6) — a guardrail hold resumed `acknowledged` whose run is no
 * longer paused falls back to SUPERSEDING the governing run. The superseding run must carry the
 * override for that one notice, or text blocks the same finding again. Only an `acknowledged`
 * resolution of a blocked (non-privacy) hold overrides — the harness's `hold_override` rule.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./support/w0-domains')),
}));

import {
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  GuardrailDirection,
  GuardrailNoticeFactory,
  GuardrailNoticeType,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { GuardrailNoticeService } from '../guardrail-notice.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const DOCTOR = 'doctor-1';
const SEG = 'seg-1';

function makeNotice(
  overrides: {
    type?: GuardrailNoticeType;
    messageKey?: string;
    checks?: unknown[];
    runId?: string | null;
    consultationId?: string;
    tenantId?: string;
  } = {},
): GuardrailNoticeEntity {
  return GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: overrides.tenantId ?? TENANT,
    consultationId: overrides.consultationId ?? CONSULTATION,
    runId: overrides.runId === undefined ? 'run-1' : overrides.runId,
    nodeId: 'n_note',
    type: overrides.type ?? GuardrailNoticeType.BLOCKED,
    direction: GuardrailDirection.INBOUND,
    action: overrides.type === GuardrailNoticeType.WARNING ? 'warn' : 'block',
    checks: (overrides.checks ?? [{ checkId: 'injection_judge', category: 'instruction_override', severity: 'high' }]) as never,
    itemIds: [SEG],
    messageKey: overrides.messageKey ?? 'guardrail.blocked.inbound',
    severity: 'high',
    requiresAcknowledgement: true,
    resumable: overrides.type !== GuardrailNoticeType.WARNING,
    policyVersion: 'pv-1',
    dedupeKey: 'dk',
  });
}

function makeHarness(
  opts: {
    notice?: GuardrailNoticeEntity;
    otherOpenBlocks?: GuardrailNoticeEntity[];
    consultationVersion?: number;
    processing?: ConsultationProcessing;
    processingReason?: string | null;
    item?: { currentVersionNumber: number; guardrailStatus?: string };
    signalFails?: boolean;
    caller?: 'human' | 'service-account';
  } = {},
) {
  const order: string[] = [];
  const notice = opts.notice ?? makeNotice();
  const row = {
    id: CONSULTATION,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: DOCTOR,
    appointmentDate: new Date('2026-10-07'),
    status: ConsultationStatus.PAUSED,
    processing: opts.processing ?? ConsultationProcessing.AWAITING_REVIEW,
    processingReason: opts.processingReason === undefined ? 'GUARDRAIL_HOLD' : opts.processingReason,
    closedReason: null,
    currentEncounterSeq: 1,
    version: opts.consultationVersion ?? 7,
    createdAt: new Date('2026-10-07'),
    updatedAt: new Date('2026-10-07'),
  };
  const entity = (overrides: Record<string, unknown> = {}) => new ConsultationEntity({ ...row, ...overrides } as never);
  const consultations = {
    findByIdOrNull: vi.fn(async (id: string) => (id === CONSULTATION ? entity() : id === 'foreign' ? entity({ id, tenantId: 'tenant-2' }) : null)),
    setProcessing: vi.fn(async (_id: string, p: ConsultationProcessing, o: { reason?: string | null }, tx?: unknown) => {
      order.push(`processing@${String(tx)}`);
      row.processing = p;
      row.processingReason = o.reason ?? null;
      return true;
    }),
  };
  const notices = {
    findByIdOrNull: vi.fn(async (id: string) => (id === notice.id ? notice : null)),
    findOpenByConsultation: vi.fn(async () => [notice]),
    findAll: vi.fn(async (args: { where: Record<string, unknown> }) => (args.where.type ? (opts.otherOpenBlocks ?? []) : [])),
    updateWithVersion: vi.fn(
      async (_id: string, entity: GuardrailNoticeEntity, _v: number, tx?: unknown) => (order.push(`notice.cas@${String(tx)}`), entity),
    ),
  };
  const evaluations = {
    findByConsultation: vi.fn(async () => [
      { noticeIds: [notice.id], checks: [{ checkId: 'injection_judge', items: [{ itemId: SEG, itemVersion: 2 }] }] },
    ]),
  };
  const contextItems = {
    findAll: vi.fn(async () => [
      {
        id: SEG,
        tenantId: TENANT,
        consultationId: CONSULTATION,
        currentVersionNumber: opts.item?.currentVersionNumber ?? 2,
        guardrailStatus: opts.item?.guardrailStatus ?? 'BLOCKED',
      },
    ]),
    setGuardrailStatusMany: vi.fn(async (ids: string[], _s: string, tx?: unknown) => (order.push(`mark@${String(tx)}`), ids.length)),
  };
  const unitOfWork = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push('tx.begin');
      const r = await work('tx');
      order.push('tx.commit');
      return r;
    }),
  };
  const lifecycleEvents = { publish: vi.fn(async () => ({})) };
  const harnessAudit = { append: vi.fn(async (input: { action: string }) => (order.push(`audit.${input.action}`), {})) };
  const harnessGateway = {
    signalGuardrailResolution: vi.fn(async () => {
      if (opts.signalFails) throw Object.assign(new Error('not paused'), { response: { status: 409 } });
      return { signaled: true };
    }),
  };
  const dispatch = { supersedeGoverningRun: vi.fn(async () => ({ superseded: true, runId: 'run-2', supersededRunId: 'run-1' })) };
  const roleAssignments = { findAll: vi.fn(async () => []) };
  const eventEmitter = { emit: vi.fn() };
  const serviceAccount = opts.caller === 'service-account' ? { id: 'sa-1' } : undefined;
  const cls = {
    get: vi.fn((key: string) =>
      key === 'tenantId'
        ? TENANT
        : key === 'user'
          ? serviceAccount
            ? undefined
            : { id: DOCTOR, roles: [] }
          : key === 'serviceAccount'
            ? serviceAccount
            : undefined,
    ),
    set: vi.fn(),
  };
  const service = new GuardrailNoticeService(
    consultations as never,
    notices as never,
    evaluations as never,
    contextItems as never,
    eventEmitter as never,
    cls as never,
    unitOfWork as never,
    lifecycleEvents as never,
    harnessAudit as never,
    harnessGateway as never,
    dispatch as never,
    roleAssignments as never,
  );
  return {
    service,
    notice,
    consultations,
    notices,
    evaluations,
    contextItems,
    unitOfWork,
    lifecycleEvents,
    harnessAudit,
    harnessGateway,
    dispatch,
    eventEmitter,
    order,
  };
}

const human = { userId: DOCTOR, isMachine: false };

describe('GuardrailNoticeService.resumeHold — supersede fallback carries the override (TASK-1059 lane O)', () => {
  it('acknowledged + the paused-run signal answers 409 ⇒ the supersede input names the acknowledged notice', async () => {
    const h = makeHarness({ signalFails: true });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledTimes(1);
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledWith(
      expect.objectContaining({
        consultationId: CONSULTATION,
        triggerId: `guardrail-hold:${h.notice.id}`,
        guardrailOverrideNoticeIds: [h.notice.id],
      }),
    );
  });

  it('item_excluded ⇒ the supersede carries no override (the composer already changed the input)', async () => {
    const h = makeHarness({ signalFails: true });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    const [input] = h.dispatch.supersedeGoverningRun.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.guardrailOverrideNoticeIds).toBeUndefined();
  });

  it('the privacy hold (redaction unavailable) is never overridable, even when acknowledged', async () => {
    const h = makeHarness({ signalFails: true, notice: makeNotice({ messageKey: 'guardrail.blocked.redaction_unavailable' }) });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });
    const [input] = h.dispatch.supersedeGoverningRun.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.guardrailOverrideNoticeIds).toBeUndefined();
  });
});
