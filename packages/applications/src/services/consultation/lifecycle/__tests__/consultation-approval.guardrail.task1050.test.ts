/**
 * TASK-1050 W2e — approve in ONE action, never blocked by warnings (README §9.8.3, OD-20, OD-24).
 *
 * Every OPEN warning of the consultation is acknowledged atomically inside the approve transaction
 * (`acknowledgedVia: 'approve'`, by the approver), the notice ids go into the signed snapshot and the
 * response lists them. A guardrail HOLD is still not approvable on its own (409 GUARDRAIL_HOLD), but
 * `resolveHold` resolves an INBOUND hold (acknowledged / item_excluded) in the same transaction; an
 * outbound hold must be resumed and regenerated first.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';

vi.mock('@arcaai/domains', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../../../guardrail-notice/__tests__/support/w0-domains')),
}));

import {
  ConsultationApprovalEntity,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ContextItemType,
  GuardrailDirection,
  GuardrailNoticeFactory,
  GuardrailNoticeStatus,
  GuardrailNoticeType,
  HarnessAuditAction,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { ConsultationApprovalService, computeSnapshotHash } from '../consultation-approval.service';
import { ConsultationLifecycleEventPublisher } from '../lifecycle-event.publisher';
import type { PreparedSessionSignature } from '../session-note-signer';

const TENANT = 'tenant-1';
const ID = 'c-1';
const DOCTOR = 'doctor-1';

type Row = ConstructorParameters<typeof ConsultationEntity>[0];

function consultation(overrides: Partial<Row> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: ID,
    tenantId: TENANT,
    patientId: 'patient-1',
    doctorId: DOCTOR,
    departmentId: null,
    appointmentDate: new Date('2026-10-05'),
    status: ConsultationStatus.STOPPED,
    processing: ConsultationProcessing.IDLE,
    currentEncounterSeq: 1,
    version: 5,
    createdAt: new Date('2026-10-05T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
    ...overrides,
  } as Row);
}

function notice(type: GuardrailNoticeType, overrides: { direction?: GuardrailDirection; messageKey?: string; checks?: unknown[] } = {}): GuardrailNoticeEntity {
  const block = type === GuardrailNoticeType.BLOCKED;
  return GuardrailNoticeFactory.CreateGuardrailNotice({
    tenantId: TENANT,
    consultationId: ID,
    type,
    direction: overrides.direction ?? GuardrailDirection.INBOUND,
    action: block ? 'block' : 'warn',
    checks: (overrides.checks ?? [{ checkId: block ? 'injection_judge' : 'unsafe_content_judge', severity: block ? 'high' : 'medium' }]) as never,
    itemIds: ['seg-1'],
    messageKey: overrides.messageKey ?? (block ? 'guardrail.blocked.inbound' : 'guardrail.warning.generic'),
    severity: block ? 'high' : 'medium',
    requiresAcknowledgement: true,
    resumable: block,
    policyVersion: 'pv-1',
    dedupeKey: `dk-${Math.random()}`,
  });
}

const prepared: PreparedSessionSignature = {
  approvedBy: DOCTOR,
  actor: { credentialClass: 'jwt', principalId: DOCTOR },
  note: null,
} as unknown as PreparedSessionSignature;

function makeHarness(row: ConsultationEntity, open: GuardrailNoticeEntity[]) {
  let current = row;
  const order: string[] = [];
  const consultations = {
    findByIdOrNull: vi.fn(async () => Object.assign(Object.create(Object.getPrototypeOf(current)), current, { _changes: {} })),
    updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity, expected: number) => {
      order.push(`consultation.cas@${expected}`);
      current = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity, { _version: entity.version + 1, _changes: {} });
      return current;
    }),
  };
  const contextItems = {
    findByConsultation: vi.fn(async () => [{ id: 'seg-1', type: ContextItemType.TRANSCRIPT_SEGMENT, currentVersionNumber: 1, encounterSeq: 1 }]),
    findByIdOrNull: vi.fn(),
    updateWithVersion: vi.fn(),
  };
  const versions = { create: vi.fn() };
  const encounters = { findByConsultation: vi.fn(async () => [{ seq: 1 }]) };
  const approvals = { create: vi.fn(async (a: ConsultationApprovalEntity) => (order.push('approval.create'), a)) };
  const audit = { append: vi.fn(async (input: { action: string }) => (order.push(`audit.${input.action}`), {})) };
  const signer = { prepareSessionSignature: vi.fn(async () => prepared), afterSessionSigned: vi.fn(async () => undefined) };
  const unitOfWork = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push('tx.begin');
      const result = await work('tx');
      order.push('tx.commit');
      return result;
    }),
  };
  const cache = { incr: vi.fn(async () => 1), eval: vi.fn(async () => 1) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)),
    set: vi.fn(),
    getId: vi.fn(() => 'req-1'),
  };
  const notices = {
    findAll: vi.fn(async () => open),
    updateWithVersion: vi.fn(async (_id: string, entity: GuardrailNoticeEntity, _v: number, tx?: unknown) => {
      order.push(`notice.cas@${String(tx)}:${entity.status}`);
      return entity;
    }),
  };
  const publisher = new ConsultationLifecycleEventPublisher(eventEmitter as never, clsService as never, cache as never, undefined);
  const service = new ConsultationApprovalService(
    consultations as never,
    contextItems as never,
    versions as never,
    encounters as never,
    approvals as never,
    audit as never,
    signer as never,
    publisher,
    eventEmitter as never,
    clsService as never,
    unitOfWork as never,
    undefined,
    notices as never,
  );
  return { service, consultations, approvals, audit, signer, notices, order, current: () => current };
}

const caller = { userId: DOCTOR, isMachine: false };

async function conflictCodeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return ((error as ConflictException).getResponse() as { code?: string }).code;
  }
  throw new Error('expected a rejection');
}

describe('approve — warnings never block, and are acknowledged in the same transaction', () => {
  it('acknowledges every open warning (via approve, by the approver) inside the transaction, snapshots and returns them', async () => {
    const warning = notice(GuardrailNoticeType.WARNING);
    const unverified = notice(GuardrailNoticeType.UNVERIFIED, { messageKey: 'guardrail.unverified.generic' });
    const h = makeHarness(consultation(), [warning, unverified]);

    const response = await h.service.approve(ID, { expectedVersion: 5, caller });

    expect(response.status).toBe('APPROVED');
    expect(warning.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
    expect(warning.acknowledgedVia).toBe('approve');
    expect(warning.acknowledgedBy).toBe(DOCTOR);
    expect(unverified.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
    const casAt = h.order.indexOf('consultation.cas@5');
    expect(h.order.slice(0, casAt + 1)).toEqual(expect.arrayContaining(['tx.begin', 'notice.cas@tx:ACKNOWLEDGED']));
    expect(h.order.indexOf('notice.cas@tx:ACKNOWLEDGED')).toBeLessThan(h.order.indexOf('tx.commit'));

    const [approval] = h.approvals.create.mock.calls[0] as unknown as [ConsultationApprovalEntity];
    const snapshot = approval.snapshot as unknown as { guardrailNotices?: string[] };
    expect(snapshot.guardrailNotices).toEqual([warning.id, unverified.id].sort());
    expect(approval.snapshotHash).toBe(computeSnapshotHash(snapshot as never));
    expect(response.acknowledgedNotices?.map((n) => [n.noticeId, n.acknowledgedVia, n.acknowledgedBy])).toEqual([
      [warning.id, 'approve', DOCTOR],
      [unverified.id, 'approve', DOCTOR],
    ]);
  });

  it('acknowledges them whether or not the client sent acknowledgeGuardrailNotices', async () => {
    const warning = notice(GuardrailNoticeType.WARNING);
    const h = makeHarness(consultation(), [warning]);
    await h.service.approve(ID, { expectedVersion: 5, caller, acknowledgeGuardrailNotices: false });
    expect(warning.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
  });

  it('leaves the snapshot unchanged (no guardrailNotices key) when there is nothing to acknowledge', async () => {
    const h = makeHarness(consultation(), []);
    const response = await h.service.approve(ID, { expectedVersion: 5, caller });
    const [approval] = h.approvals.create.mock.calls[0] as unknown as [ConsultationApprovalEntity];
    expect(Object.keys(approval.snapshot as object)).toEqual(['items']);
    expect(response.acknowledgedNotices).toEqual([]);
  });
});

describe('approve — a guardrail hold', () => {
  const held = () => consultation({ processing: ConsultationProcessing.AWAITING_REVIEW, processingReason: 'GUARDRAIL_HOLD' } as Partial<Row>);

  it('is 409 GUARDRAIL_HOLD on its own', async () => {
    const h = makeHarness(held(), [notice(GuardrailNoticeType.BLOCKED)]);
    expect(await conflictCodeOf(h.service.approve(ID, { expectedVersion: 5, caller }))).toBe('GUARDRAIL_HOLD');
    expect(h.consultations.updateWithVersion).not.toHaveBeenCalled();
  });

  it('resolveHold on an INBOUND hold (item_excluded) resolves it and approves in one transaction; processing back to IDLE', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED);
    const h = makeHarness(held(), [block]);
    const response = await h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'item_excluded' } });

    expect(response.status).toBe('APPROVED');
    expect(block.status).toBe(GuardrailNoticeStatus.RESOLVED);
    expect(block.resolution).toBe('item_excluded');
    expect(h.order.indexOf('notice.cas@tx:RESOLVED')).toBeLessThan(h.order.indexOf('tx.commit'));
    expect(h.current().processing).toBe(ConsultationProcessing.IDLE);
    const [approval] = h.approvals.create.mock.calls[0] as unknown as [ConsultationApprovalEntity];
    expect((approval.snapshot as unknown as { guardrailNotices?: string[] }).guardrailNotices).toEqual([block.id]);
  });

  it('resolveHold acknowledged on an inbound tenant-set block is recorded as a SAFETY_OVERRIDE in the transaction', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED);
    const h = makeHarness(held(), [block]);
    await h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'acknowledged' } });
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: HarnessAuditAction.SAFETY_OVERRIDE, modelName: 'guardrail-hold-override' }));
    expect(h.order.indexOf(`audit.${HarnessAuditAction.SAFETY_OVERRIDE}`)).toBeLessThan(h.order.indexOf('tx.commit'));
  });

  it('resolveHold on an OUTBOUND hold is 409 GUARDRAIL_HOLD: the withheld note was never seen (OD-24)', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED, { direction: GuardrailDirection.OUTBOUND, messageKey: 'guardrail.blocked.outbound' });
    const h = makeHarness(held(), [block]);
    expect(await conflictCodeOf(h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'acknowledged' } }))).toBe(
      'GUARDRAIL_HOLD',
    );
    expect(block.status).toBe(GuardrailNoticeStatus.OPEN);
  });

  it('resolveHold item_edited is 409 GUARDRAIL_HOLD (an edit needs a regenerated note first)', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED);
    const h = makeHarness(held(), [block]);
    expect(await conflictCodeOf(h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'item_edited' } }))).toBe(
      'GUARDRAIL_HOLD',
    );
  });

  it('resolveHold acknowledged on the locked medical block is refused (409 GUARDRAIL_OVERRIDE_NOT_ALLOWED)', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED, { messageKey: 'guardrail.blocked.not_medical', checks: [{ checkId: 'medical_validation', severity: 'high' }] });
    const h = makeHarness(held(), [block]);
    expect(await conflictCodeOf(h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'acknowledged' } }))).toBe(
      'GUARDRAIL_OVERRIDE_NOT_ALLOWED',
    );
  });

  it('a hold with warnings beside it: resolves the hold AND acknowledges the warnings, all in one approve', async () => {
    const block = notice(GuardrailNoticeType.BLOCKED);
    const warning = notice(GuardrailNoticeType.WARNING);
    const h = makeHarness(held(), [block, warning]);
    const response = await h.service.approve(ID, { expectedVersion: 5, caller, resolveHold: { noticeId: block.id, resolution: 'item_excluded' } });
    expect(warning.status).toBe(GuardrailNoticeStatus.ACKNOWLEDGED);
    expect(response.acknowledgedNotices?.map((n) => n.noticeId)).toEqual([warning.id]);
  });
});
