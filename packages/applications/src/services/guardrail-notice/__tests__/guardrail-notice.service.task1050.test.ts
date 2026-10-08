/**
 * TASK-1050 W2e — the business-plane notice surface: list, acknowledge (If-Match on the
 * consultation, audited) and the guardrail-hold resume (README §9.7.4, §9.7.5, §9.8.1, OD-18, OD-22).
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./support/w0-domains')),
}));

import {
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  GuardrailDirection,
  GuardrailItemStatus,
  GuardrailNoticeFactory,
  GuardrailNoticeStatus,
  GuardrailNoticeType,
  HarnessAuditAction,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { GuardrailNoticeService } from '../guardrail-notice.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const DOCTOR = 'doctor-1';
const SEG = 'seg-1';

function makeNotice(
  overrides: { type?: GuardrailNoticeType; messageKey?: string; checks?: unknown[]; runId?: string | null; consultationId?: string; tenantId?: string } = {},
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
    findAll: vi.fn(async (args: { where: Record<string, unknown> }) =>
      (args.where.type ? (opts.otherOpenBlocks ?? []) : []),
    ),
    updateWithVersion: vi.fn(async (_id: string, entity: GuardrailNoticeEntity, _v: number, tx?: unknown) => (order.push(`notice.cas@${String(tx)}`), entity)),
  };
  const evaluations = {
    findByConsultation: vi.fn(async () => [
      { noticeIds: [notice.id], checks: [{ checkId: 'injection_judge', items: [{ itemId: SEG, itemVersion: 2 }] }] },
    ]),
  };
  const contextItems = {
    findAll: vi.fn(async () => [
      { id: SEG, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: opts.item?.currentVersionNumber ?? 2, guardrailStatus: opts.item?.guardrailStatus ?? 'BLOCKED' },
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
      key === 'tenantId' ? TENANT : key === 'user' ? (serviceAccount ? undefined : { id: DOCTOR, roles: [] }) : key === 'serviceAccount' ? serviceAccount : undefined,
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
  return { service, notice, consultations, notices, evaluations, contextItems, unitOfWork, lifecycleEvents, harnessAudit, harnessGateway, dispatch, eventEmitter, order };
}

const human = { userId: DOCTOR, isMachine: false };

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function codeOf(error: unknown): unknown {
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { code?: string }).code;
}

describe('GuardrailNoticeService.list', () => {
  it('answers the open notices of the consultation as v1 notice views (no content)', async () => {
    const h = makeHarness();
    const page = await h.service.list(CONSULTATION);
    expect(Object.keys(page).sort()).toEqual(['notices', 'unacknowledgedNoticeIds']);
    expect(page.unacknowledgedNoticeIds).toEqual([h.notice.id]);
    expect(page.notices).toHaveLength(1);
    expect(page.notices[0]).toMatchObject({ noticeId: h.notice.id, type: 'guardrail.blocked', status: 'open', schemaVersion: 1, messageKey: 'guardrail.blocked.inbound' });
    expect(page.notices[0].defaultMessage).toMatch(/stopped this request/);
  });

  it('is 404 for another tenant`s consultation (404-over-403)', async () => {
    const h = makeHarness();
    await expect(h.service.list('foreign')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GuardrailNoticeService.acknowledge', () => {
  it('records the clinician, via `notice`, compare-and-set on the notice, and audits it', async () => {
    const h = makeHarness({ notice: makeNotice({ type: GuardrailNoticeType.WARNING, messageKey: 'guardrail.warning.generic' }) });
    const result = await h.service.acknowledge(CONSULTATION, h.notice.id, { expectedVersion: 7, caller: human });
    expect(Object.keys(result).sort()).toEqual(['acknowledgement', 'notice']);
    expect(result.notice.status).toBe('acknowledged');
    expect(result.acknowledgement).toMatchObject({ noticeId: h.notice.id, acknowledgedBy: DOCTOR, acknowledgedVia: 'ack' });
    expect(h.notice.acknowledgedVia).toBe('notice');
    expect(h.notices.updateWithVersion).toHaveBeenCalledWith(h.notice.id, h.notice, h.notice.version, undefined);
    const audited = h.eventEmitter.emit.mock.calls.map(([, p]) => p as { forceAuditLog?: boolean; data?: { action?: string } });
    expect(audited.some((p) => p.forceAuditLog && p.data?.action === 'guardrail_notice_acknowledged')).toBe(true);
  });

  it('is 412 when If-Match names another consultation version', async () => {
    const h = makeHarness();
    await expect(h.service.acknowledge(CONSULTATION, h.notice.id, { expectedVersion: 6, caller: human })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(h.notices.updateWithVersion).not.toHaveBeenCalled();
  });

  it('is 404 for a notice of another consultation, and for a foreign consultation', async () => {
    const h = makeHarness({ notice: makeNotice({ consultationId: 'c-other' }) });
    await expect(h.service.acknowledge(CONSULTATION, h.notice.id, { expectedVersion: 7, caller: human })).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.acknowledge('foreign', h.notice.id, { expectedVersion: 7, caller: human })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires a machine credential to name the clinician (TASK-933 shape)', async () => {
    const h = makeHarness({ caller: 'service-account' });
    const error = await rejectionOf(h.service.acknowledge(CONSULTATION, h.notice.id, { expectedVersion: 7, caller: { serviceAccountId: 'sa-1', isMachine: true } }));
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(400);
  });
});

describe('GuardrailNoticeService.resumeHold', () => {
  it('item_excluded: resolves the notice, releases the hold (processing IDLE) in one transaction, then signals the paused run', async () => {
    const h = makeHarness();
    const result = await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });

    expect(h.notice.status).toBe(GuardrailNoticeStatus.RESOLVED);
    expect(h.notice.resolution).toBe('item_excluded');
    expect(h.order).toEqual(['tx.begin', 'notice.cas@tx', 'processing@tx', 'tx.commit']);
    expect(h.consultations.setProcessing).toHaveBeenCalledWith(CONSULTATION, ConsultationProcessing.IDLE, { reason: null }, 'tx');
    expect(h.harnessGateway.signalGuardrailResolution).toHaveBeenCalledWith('run-1', { noticeId: h.notice.id, resolution: 'item_excluded', by: DOCTOR }, TENANT);
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
    // The lifecycle-verb response (a fresh read: processing is back to IDLE) plus the resolved notice.
    expect(result).toMatchObject({ id: CONSULTATION, status: 'PAUSED', processing: ConsultationProcessing.IDLE, version: 7, resolvedNoticeId: h.notice.id });
    const [, type, extras] = h.lifecycleEvents.publish.mock.calls[0] as unknown as [unknown, string, { noticeId?: string }];
    expect(type).toBe('processing_changed');
    expect(extras.noticeId).toBe(h.notice.id);
  });

  it('falls back to the supersede path when the run is no longer paused on the notice', async () => {
    const h = makeHarness({ signalFails: true });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    expect(h.dispatch.supersedeGoverningRun).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: CONSULTATION, tenantId: TENANT, triggerId: `guardrail-hold:${h.notice.id}` }),
    );
  });

  it('acknowledged: allowed for a tenant-set block, recorded as a SAFETY_OVERRIDE inside the transaction', async () => {
    const h = makeHarness();
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });
    expect(h.harnessAudit.append).toHaveBeenCalledWith(expect.objectContaining({ action: HarnessAuditAction.SAFETY_OVERRIDE, consultationId: CONSULTATION, clinicianId: DOCTOR }));
    expect(h.order.indexOf('audit.SAFETY_OVERRIDE')).toBeLessThan(h.order.indexOf('tx.commit'));
  });

  it('acknowledged: refused (409) for the platform-locked medical block — exclude or edit only', async () => {
    const h = makeHarness({
      notice: makeNotice({ messageKey: 'guardrail.blocked.not_medical', checks: [{ checkId: 'medical_validation', category: 'not_medical', severity: 'high' }] }),
    });
    const error = await rejectionOf(h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human }));
    expect(codeOf(error)).toBe('GUARDRAIL_OVERRIDE_NOT_ALLOWED');
    expect(h.notices.updateWithVersion).not.toHaveBeenCalled();
    expect(h.harnessAudit.append).not.toHaveBeenCalled();
    // …while excluding the item resumes it.
    await expect(
      h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human }),
    ).resolves.toMatchObject({ processing: ConsultationProcessing.IDLE, resolvedNoticeId: h.notice.id });
  });

  it('item_edited: refused (409) while no flagged item has a version newer than the blocked one', async () => {
    const h = makeHarness({ item: { currentVersionNumber: 2 } });
    const error = await rejectionOf(h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_edited' }, { expectedVersion: 7, caller: human }));
    expect(codeOf(error)).toBe('GUARDRAIL_ITEM_NOT_EDITED');
  });

  it('item_edited: once the item has a newer version, its marker is cleared (re-screened) and the hold released', async () => {
    const h = makeHarness({ item: { currentVersionNumber: 3, guardrailStatus: 'BLOCKED' } });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_edited' }, { expectedVersion: 7, caller: human });
    expect(h.contextItems.setGuardrailStatusMany).toHaveBeenCalledWith([SEG], GuardrailItemStatus.CLEAN, 'tx');
    expect(h.notice.resolution).toBe('item_edited');
  });

  it('keeps the hold while another unresolved block notice remains', async () => {
    const h = makeHarness({ otherOpenBlocks: [makeNotice()] });
    const result = await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    expect(h.consultations.setProcessing).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processing: ConsultationProcessing.AWAITING_REVIEW, processingReason: 'GUARDRAIL_HOLD', resolvedNoticeId: h.notice.id });
  });

  it('refuses to resume a warning (409 GUARDRAIL_NOTICE_NOT_RESUMABLE)', async () => {
    const h = makeHarness({ notice: makeNotice({ type: GuardrailNoticeType.WARNING, messageKey: 'guardrail.warning.generic' }) });
    const error = await rejectionOf(h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human }));
    expect(codeOf(error)).toBe('GUARDRAIL_NOTICE_NOT_RESUMABLE');
  });

  it('is idempotent on a retried resume with the same resolution, and 409 with a different one', async () => {
    const h = makeHarness();
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    h.harnessGateway.signalGuardrailResolution.mockClear();
    const again = await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    expect(again.resolvedNoticeId).toBe(h.notice.id);
    expect(h.harnessGateway.signalGuardrailResolution).not.toHaveBeenCalled();
    const error = await rejectionOf(h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human }));
    expect(codeOf(error)).toBe('GUARDRAIL_NOTICE_RESOLVED');
  });

  it('is 412 on a stale If-Match and 404 for an unknown notice', async () => {
    const h = makeHarness();
    await expect(
      h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 1, caller: human }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    await expect(
      h.service.resumeHold(CONSULTATION, { noticeId: 'nope', resolution: 'item_excluded' }, { expectedVersion: 7, caller: human }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not dispatch anything for a hold raised outside a run (the next live tick re-screens)', async () => {
    const h = makeHarness({ notice: makeNotice({ runId: null }) });
    await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human });
    expect(h.harnessGateway.signalGuardrailResolution).not.toHaveBeenCalled();
    expect(h.dispatch.supersedeGoverningRun).not.toHaveBeenCalled();
  });
});

/** A notice that lists every check that raised it (one per direction, type and target). */
const THREE_CHECKS = [
  { checkId: 'injection_judge', category: 'instruction_override', severity: 'high' },
  { checkId: 'unsafe_content_judge', category: 'violence', severity: 'medium' },
  { checkId: 'leakage_judge', category: 'secret', severity: 'low' },
];

describe('GuardrailNoticeService — a notice listing three checks (E)', () => {
  it('list: the view carries every check of the notice, in order', async () => {
    const h = makeHarness({ notice: makeNotice({ checks: THREE_CHECKS }) });
    const result = await h.service.list(CONSULTATION);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0].checks.map((check) => check.checkId)).toEqual(['injection_judge', 'unsafe_content_judge', 'leakage_judge']);
  });

  it('acknowledge: one call acknowledges the single notice, however many checks it lists', async () => {
    const h = makeHarness({ notice: makeNotice({ type: GuardrailNoticeType.WARNING, messageKey: 'guardrail.warning.generic', checks: THREE_CHECKS }) });
    const result = await h.service.acknowledge(CONSULTATION, h.notice.id, { expectedVersion: 7, caller: human });
    expect(result.notice.status).toBe('acknowledged');
    expect(result.notice.checks).toHaveLength(3);
    expect(h.notices.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('resume (acknowledged): ONE resume releases the hold; the SAFETY_OVERRIDE records all three checks', async () => {
    const h = makeHarness({ notice: makeNotice({ checks: THREE_CHECKS }) });
    const result = await h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human });
    expect(result).toMatchObject({ processing: ConsultationProcessing.IDLE, resolvedNoticeId: h.notice.id });
    expect(h.notices.updateWithVersion).toHaveBeenCalledTimes(1);
    const [audit] = h.harnessAudit.append.mock.calls[0] as unknown as [{ sensorScores: { checks: Array<{ checkId: string }> } }];
    expect(audit.sensorScores.checks.map((check) => check.checkId)).toEqual(['injection_judge', 'unsafe_content_judge', 'leakage_judge']);
  });

  it('resume (acknowledged): refused (409) when ANY listed check is catalogue-locked at block', async () => {
    const checks = [THREE_CHECKS[0], { checkId: 'medical_validation', category: 'not_medical', severity: 'high' }, THREE_CHECKS[2]];
    const h = makeHarness({ notice: makeNotice({ checks }) });
    const error = await rejectionOf(h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'acknowledged' }, { expectedVersion: 7, caller: human }));
    expect(codeOf(error)).toBe('GUARDRAIL_OVERRIDE_NOT_ALLOWED');
    expect(h.notices.updateWithVersion).not.toHaveBeenCalled();
    expect(h.harnessAudit.append).not.toHaveBeenCalled();
  });

  it('resume (item_excluded): a locked check among three still resumes with the item resolutions', async () => {
    const checks = [THREE_CHECKS[0], { checkId: 'medical_validation', category: 'not_medical', severity: 'high' }, THREE_CHECKS[2]];
    const h = makeHarness({ notice: makeNotice({ checks }) });
    await expect(
      h.service.resumeHold(CONSULTATION, { noticeId: h.notice.id, resolution: 'item_excluded' }, { expectedVersion: 7, caller: human }),
    ).resolves.toMatchObject({ processing: ConsultationProcessing.IDLE });
  });
});
