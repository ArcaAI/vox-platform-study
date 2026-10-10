/**
 * TASK-1059 RC-10 — approve leaves the consultation with `processing` IDLE.
 *
 * Approve used to reset processing only when it cleared a guardrail hold, so a note outcome
 * (AWAITING_REVIEW + NOTE_COVERAGE_GAPS, FAILED, IDLE + NOTE_READY) survived the sign-off and a
 * closed consultation still read AWAITING_REVIEW (TASK-1058 D-13). The signed note is the outcome now.
 */
import { describe, expect, it, vi } from 'vitest';

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
  GuardrailNoticeType,
  type GuardrailNoticeEntity,
} from '@arcaai/domains';
import { ConsultationApprovalService } from '../consultation-approval.service';
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

describe('approve — processing ends IDLE (RC-10)', () => {
  it.each([
    [ConsultationProcessing.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:3'],
    [ConsultationProcessing.FAILED, 'NOTE_GENERATION_FAILED'],
    [ConsultationProcessing.IDLE, 'NOTE_READY'],
  ])('a note outcome (%s / %s) is cleared by the approve write', async (processing, processingReason) => {
    const h = makeHarness(consultation({ processing, processingReason } as Partial<Row>), []);
    await h.service.approve(ID, { expectedVersion: 5, caller });

    const [, written] = h.consultations.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity];
    expect(written.status).toBe(ConsultationStatus.APPROVED);
    expect(written.processing).toBe(ConsultationProcessing.IDLE);
    expect(written.processingReason).toBeNull();
  });

  it('attachment work still in flight is left to the attachment pipeline', async () => {
    const h = makeHarness(consultation({ processing: ConsultationProcessing.PROCESSING_ATTACHMENT } as Partial<Row>), []);
    await h.service.approve(ID, { expectedVersion: 5, caller });
    const [, written] = h.consultations.updateWithVersion.mock.calls[0] as unknown as [string, ConsultationEntity];
    expect(written.processing).toBe(ConsultationProcessing.PROCESSING_ATTACHMENT);
  });
});
