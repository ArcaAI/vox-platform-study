/**
 * TASK-1045 lane AB-4a — session approve: one approval of the whole consultation record.
 *
 * Snapshot of every item's current version + hash → `ConsultationApproval`; ATTEST +
 * SESSION_APPROVED on the WORM trail (fail-closed, inside the transaction); the per-note signing
 * and the harness hand-off stay with the summary service's signing core; D-26 late sign-off on
 * CLOSED_INCOMPLETE; D-29 idempotent on CLOSED_COMPLETE.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  ConsultationApprovalEntity,
  ConsultationClosedReason,
  ConsultationEntity,
  ConsultationProcessing,
  ConsultationStatus,
  ContextItemType,
  HarnessAuditAction,
} from '@arcaai/domains';
import { ConsultationPipelineEvent } from '../../events/consultation.events';
import { ConsultationApprovalService, computeSnapshotHash } from '../consultation-approval.service';
import { ConsultationLifecycleEventPublisher } from '../lifecycle-event.publisher';
import type { PreparedSessionSignature } from '../session-note-signer';

const TENANT = 'tenant-1';
const ID = 'c-1';
const DOCTOR = 'doctor-1';
const NOTE = 'note-1';

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
    processing: ConsultationProcessing.AWAITING_REVIEW,
    currentEncounterSeq: 2,
    version: 5,
    createdAt: new Date('2026-10-05T08:00:00Z'),
    updatedAt: new Date('2026-10-05T08:00:00Z'),
    ...overrides,
  } as Row);
}

const items = [
  { id: 'seg-2', type: ContextItemType.TRANSCRIPT_SEGMENT, currentVersionNumber: 1, encounterSeq: 2 },
  { id: NOTE, type: ContextItemType.MODIFIED_SUMMARY, currentVersionNumber: 3, encounterSeq: null },
  { id: 'seg-1', type: ContextItemType.TRANSCRIPT_SEGMENT, currentVersionNumber: 2, encounterSeq: 1 },
];

function preparedWithNote(): PreparedSessionSignature {
  return {
    approvedBy: DOCTOR,
    actor: { credentialClass: 'jwt', principalId: DOCTOR },
    note: {
      contextItem: { id: NOTE, version: 9, currentVersionNumber: 4 } as never,
      version: { id: 'ver-4' } as never,
      versionId: 'ver-4',
      versionNumber: 4,
      attestationHash: 'note-hash',
      attestedAt: new Date('2026-10-05T09:00:00Z'),
      signedBeforeAssurance: false,
      safetyOverride: false,
    },
  };
}

function makeHarness(row: ConsultationEntity, opts: { prepared?: PreparedSessionSignature; auditFails?: boolean } = {}) {
  let current = row;
  const order: string[] = [];
  const consultations = {
    // A fresh read every time, like the database: the service's in-memory edits never leak back.
    findByIdOrNull: vi.fn(async () => Object.assign(Object.create(Object.getPrototypeOf(current)), current, { _changes: {} })),
    updateWithVersion: vi.fn(async (_id: string, entity: ConsultationEntity, expected: number) => {
      order.push(`consultation.cas@${expected}`);
      current = Object.assign(Object.create(Object.getPrototypeOf(entity)), entity, { _version: entity.version + 1, _changes: {} });
      return current;
    }),
  };
  const contextItems = {
    findByConsultation: vi.fn(async () => items),
    // The legacy per-summary route's note id: this consultation's note, another tenant's item, and
    // another consultation's item of the same tenant.
    findByIdOrNull: vi.fn(async (id: string) =>
      id === NOTE
        ? { id: NOTE, tenantId: TENANT, consultationId: ID }
        : id === 'foreign-note'
          ? { id, tenantId: 'tenant-2', consultationId: 'c-9' }
          : id === 'other-consultation-note'
            ? { id, tenantId: TENANT, consultationId: 'c-2' }
            : null,
    ),
    updateWithVersion: vi.fn(async (_id: string, e: unknown, expected: number) => (order.push(`note.cas@${expected}`), e)),
  };
  const contextItemWriter = contextItems;
  const versions = { create: vi.fn(async (v: unknown) => (order.push('version.create'), v)) };
  const encounters = { findByConsultation: vi.fn(async () => [{ seq: 1 }, { seq: 2 }]) };
  const approvals = { create: vi.fn(async (a: ConsultationApprovalEntity) => (order.push('approval.create'), a)) };
  const audit = {
    append: vi.fn(async (input: { action: string }) => {
      order.push(`audit.${input.action}`);
      if (opts.auditFails && input.action === HarnessAuditAction.SESSION_APPROVED) throw new Error('worm down');
      return {};
    }),
  };
  const signer = {
    prepareSessionSignature: vi.fn(async () => opts.prepared ?? preparedWithNote()),
    afterSessionSigned: vi.fn(async () => undefined),
  };
  const unitOfWork = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push('tx.begin');
      const snapshot = current;
      try {
        const result = await work('tx');
        order.push('tx.commit');
        return result;
      } catch (error) {
        current = snapshot;
        order.push('tx.rollback');
        throw error;
      }
    }),
  };
  const cache = { incr: vi.fn(async () => 1), eval: vi.fn(async () => 1) };
  const encounterService = {
    lifecycleView: vi.fn(async () => ({ encounters: [], approval: null, autoCloseAt: null, allowClosedCompleteReopen: false })),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: DOCTOR, roles: [] } : undefined)),
    set: vi.fn(),
    getId: vi.fn(() => 'req-1'),
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
    encounterService as never,
  );
  const lifecycleEvents = () =>
    eventEmitter.emit.mock.calls
      .filter(([name]) => name === ConsultationPipelineEvent.LifecycleChanged)
      .map(([, payload]) => (payload as { event: { type: string; status: string } }).event);
  return {
    service,
    encounterService,
    consultations,
    contextItems,
    versions,
    contextItemWriter,
    approvals,
    audit,
    signer,
    unitOfWork,
    order,
    lifecycleEvents,
    current: () => current,
  };
}

const caller = { userId: DOCTOR, isMachine: false };

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function conflictCode(error: unknown): unknown {
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { code?: string }).code;
}

describe('ConsultationApprovalService.approve — STOPPED → APPROVED', () => {
  it('snapshots every item at its current version (the note at its signed version), hashes it and stores the approval', async () => {
    const h = makeHarness(consultation());
    const response = await h.service.approve(ID, { expectedVersion: 5, caller });

    expect(response.status).toBe('APPROVED');
    expect(h.current().approvedAt).toBeInstanceOf(Date);
    expect(h.encounterService.lifecycleView).toHaveBeenCalledWith(h.current());

    const approval = h.approvals.create.mock.calls[0][0] as ConsultationApprovalEntity;
    const expectedSnapshot = {
      items: [
        { contextItemId: NOTE, type: 'MODIFIED_SUMMARY', versionNumber: 4, encounterSeq: null },
        { contextItemId: 'seg-1', type: 'TRANSCRIPT_SEGMENT', versionNumber: 2, encounterSeq: 1 },
        { contextItemId: 'seg-2', type: 'TRANSCRIPT_SEGMENT', versionNumber: 1, encounterSeq: 2 },
      ],
    };
    expect(approval.snapshot).toEqual(expectedSnapshot);
    expect(approval.snapshotHash).toBe(computeSnapshotHash(expectedSnapshot));
    expect(approval.snapshotHash).toBe(createHash('sha256').update(JSON.stringify(expectedSnapshot)).digest('hex'));
    expect(approval).toMatchObject({ tenantId: TENANT, consultationId: ID, approvedBy: DOCTOR, consultationVersion: 6, encounterCount: 2 });
    expect(approval.attestationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the note version, both CAS writes, the approval and the WORM rows inside ONE transaction, audits last', async () => {
    const h = makeHarness(consultation());
    await h.service.approve(ID, { expectedVersion: 5, caller });
    expect(h.order).toEqual([
      'tx.begin',
      'version.create',
      'note.cas@9',
      'consultation.cas@5',
      'approval.create',
      `audit.${HarnessAuditAction.ATTEST}`,
      `audit.${HarnessAuditAction.SESSION_APPROVED}`,
      'tx.commit',
    ]);
    const attest = h.audit.append.mock.calls[0][0];
    expect(attest).toMatchObject({
      tenantId: TENANT,
      consultationId: ID,
      contextItemVersionId: 'ver-4',
      clinicianId: DOCTOR,
      attestationHash: 'note-hash',
    });
    const session = h.audit.append.mock.calls[1][0];
    expect(session).toMatchObject({ action: HarnessAuditAction.SESSION_APPROVED, clinicianId: DOCTOR, contextItemVersionId: 'ver-4' });
  });

  it('hands the signed note to the signing core after commit (harness approval signal), then emits approved', async () => {
    const h = makeHarness(consultation());
    await h.service.approve(ID, { expectedVersion: 5, caller, clinicianUserId: DOCTOR, overrideSafetyFlag: true });
    expect(h.signer.prepareSessionSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        consultationId: ID,
        clinicianUserId: DOCTOR,
        overrideSafetyFlag: true,
        caller: { credentialClass: 'jwt', principalId: DOCTOR },
      }),
    );
    expect(h.signer.afterSessionSigned).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, approvedBy: DOCTOR, note: expect.objectContaining({ versionId: 'ver-4' }) }),
    );
    expect(h.lifecycleEvents()).toEqual([expect.objectContaining({ type: 'approved', status: 'APPROVED' })]);
  });

  it('a machine caller is converted to the attribution form (service account / API key)', async () => {
    const h = makeHarness(consultation());
    await h.service.approve(ID, { expectedVersion: 5, caller: { serviceAccountId: 'sa-1', isMachine: true }, clinicianUserId: DOCTOR });
    expect(h.signer.prepareSessionSignature.mock.calls[0][0]).toMatchObject({ caller: { credentialClass: 'service-account', principalId: 'sa-1' } });

    const k = makeHarness(consultation());
    await k.service.approve(ID, { expectedVersion: 5, caller: { apiKeyId: 'key-1', userId: 'bound-1', isMachine: true }, clinicianUserId: DOCTOR });
    expect(k.signer.prepareSessionSignature.mock.calls[0][0]).toMatchObject({
      caller: { credentialClass: 'api-key', principalId: 'key-1', boundUserId: 'bound-1' },
    });
  });

  it('records the safety override and the signed-before-assurance annotations when the signing core reports them', async () => {
    const prepared = preparedWithNote();
    prepared.note!.safetyOverride = true;
    prepared.note!.signedBeforeAssurance = true;
    const h = makeHarness(consultation(), { prepared });
    await h.service.approve(ID, { expectedVersion: 5, caller });
    expect(h.audit.append.mock.calls.map(([input]) => input.action)).toEqual([
      HarnessAuditAction.SAFETY_OVERRIDE,
      HarnessAuditAction.ATTEST,
      HarnessAuditAction.SIGNED_BEFORE_ASSURANCE,
      HarnessAuditAction.SESSION_APPROVED,
    ]);
  });

  it('a consultation with no final note still approves: ATTEST without a version, no note writes', async () => {
    const h = makeHarness(consultation(), { prepared: { approvedBy: DOCTOR, actor: { credentialClass: 'jwt', principalId: DOCTOR }, note: null } });
    await h.service.approve(ID, { expectedVersion: 5, caller });
    expect(h.versions.create).not.toHaveBeenCalled();
    expect(h.contextItemWriter.updateWithVersion).not.toHaveBeenCalled();
    const attest = h.audit.append.mock.calls[0][0];
    expect(attest).toMatchObject({ action: HarnessAuditAction.ATTEST, contextItemVersionId: null });
    expect(h.signer.afterSessionSigned).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it('an already-signed current note version is not re-signed (no version row, no note CAS)', async () => {
    const prepared = preparedWithNote();
    prepared.note!.version = null;
    const h = makeHarness(consultation(), { prepared });
    await h.service.approve(ID, { expectedVersion: 5, caller });
    expect(h.versions.create).not.toHaveBeenCalled();
    expect(h.contextItemWriter.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a WORM failure rolls the whole approval back: no events, no harness hand-off', async () => {
    const h = makeHarness(consultation(), { auditFails: true });
    expect(await rejectionOf(h.service.approve(ID, { expectedVersion: 5, caller }))).toBeInstanceOf(Error);
    expect(h.order).toContain('tx.rollback');
    expect(h.current().status).toBe(ConsultationStatus.STOPPED);
    expect(h.signer.afterSessionSigned).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([]);
  });

  it('legacy per-summary approve: expectedVersion is the NOTE If-Match, the consultation CAS uses its own version', async () => {
    const h = makeHarness(consultation());
    await h.service.approve(ID, { expectedVersion: 2, legacyContextItemId: NOTE, caller });
    expect(h.signer.prepareSessionSignature.mock.calls[0][0]).toMatchObject({ legacyContextItemId: NOTE });
    expect(h.order).toContain('note.cas@2');
    expect(h.order).toContain('consultation.cas@5');
  });
});

describe('ConsultationApprovalService.approve — refusals', () => {
  it.each([ConsultationProcessing.FINALIZING_TRANSCRIPT, ConsultationProcessing.SUMMARIZING])(
    'refuses while processing is %s (409 CONSULTATION_PROCESSING_IN_FLIGHT) before anything is signed',
    async (processing) => {
      const h = makeHarness(consultation({ processing }));
      expect(conflictCode(await rejectionOf(h.service.approve(ID, { expectedVersion: 5, caller })))).toBe('CONSULTATION_PROCESSING_IN_FLIGHT');
      expect(h.signer.prepareSessionSignature).not.toHaveBeenCalled();
      expect(h.unitOfWork.runInTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([ConsultationStatus.OPEN, ConsultationStatus.RECORDING, ConsultationStatus.PAUSED])(
    'refuses %s → APPROVED with 409 CONSULTATION_TRANSITION_ILLEGAL',
    async (status) => {
      const h = makeHarness(consultation({ status, processing: ConsultationProcessing.IDLE }));
      expect(conflictCode(await rejectionOf(h.service.approve(ID, { expectedVersion: 5, caller })))).toBe('CONSULTATION_TRANSITION_ILLEGAL');
    },
  );

  it('answers 404 for another tenant', async () => {
    const h = makeHarness(consultation({ tenantId: 'tenant-2' }));
    expect(await rejectionOf(h.service.approve(ID, { expectedVersion: 5, caller }))).toBeInstanceOf(NotFoundException);
  });
});

describe('ConsultationApprovalService.approve — legacy per-summary route: existence before legality', () => {
  it.each([
    ['an unknown summary id', 'missing-note'],
    ["another tenant's summary id", 'foreign-note'],
    ["another consultation's summary id", 'other-consultation-note'],
  ])('answers 404 for %s even where the transition would be illegal (OPEN)', async (_label, noteId) => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN, processing: ConsultationProcessing.IDLE }));
    const error = await rejectionOf(h.service.approve(ID, { expectedVersion: 1, legacyContextItemId: noteId, caller }));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(h.signer.prepareSessionSignature).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown summary id on an already-approved consultation (no idempotent 200 for a missing note)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.APPROVED, processing: ConsultationProcessing.IDLE }));
    expect(await rejectionOf(h.service.approve(ID, { expectedVersion: 1, legacyContextItemId: 'missing-note', caller }))).toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a known summary id of this consultation still reaches the legality check (OPEN → 409)', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.OPEN, processing: ConsultationProcessing.IDLE }));
    const error = await rejectionOf(h.service.approve(ID, { expectedVersion: 1, legacyContextItemId: NOTE, caller }));
    expect(conflictCode(error)).toBe('CONSULTATION_TRANSITION_ILLEGAL');
  });
});

describe('ConsultationApprovalService.approve — idempotency (D-29)', () => {
  it.each([ConsultationStatus.CLOSED_COMPLETE, ConsultationStatus.APPROVED])('is a no-op on %s', async (status) => {
    const h = makeHarness(consultation({ status, processing: ConsultationProcessing.IDLE }));
    const response = await h.service.approve(ID, { expectedVersion: 1, caller });
    expect(response.status).toBe(status);
    expect(h.signer.prepareSessionSignature).not.toHaveBeenCalled();
    expect(h.unitOfWork.runInTransaction).not.toHaveBeenCalled();
    expect(h.lifecycleEvents()).toEqual([]);
  });
});

describe('ConsultationApprovalService.approve — late sign-off on CLOSED_INCOMPLETE (D-26)', () => {
  it('reopens, approves and closes atomically → CLOSED_COMPLETE, audited as a late sign-off', async () => {
    const closedAt = new Date('2026-10-04T20:00:00Z');
    const h = makeHarness(
      consultation({
        status: ConsultationStatus.CLOSED_INCOMPLETE,
        processing: ConsultationProcessing.IDLE,
        closedReason: ConsultationClosedReason.AUTO,
        closedAt,
      }),
    );
    const response = await h.service.approve(ID, { expectedVersion: 5, caller });

    expect(response.status).toBe('CLOSED_COMPLETE');
    const row = h.current();
    expect(row.closedReason).toBe(ConsultationClosedReason.APPROVED);
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect(row.closedAt).toBeInstanceOf(Date);
    expect(row.closedAt?.getTime()).not.toBe(closedAt.getTime());
    expect(row.reopenCount).toBe(1);
    // ONE consultation write: the intermediate states never persist.
    expect(h.consultations.updateWithVersion).toHaveBeenCalledTimes(1);

    const approval = h.approvals.create.mock.calls[0][0] as ConsultationApprovalEntity;
    expect(approval.metaData).toMatchObject({ lateSignOff: true, fromStatus: 'CLOSED_INCOMPLETE' });
    const session = h.audit.append.mock.calls.find(([input]) => input.action === HarnessAuditAction.SESSION_APPROVED)?.[0];
    expect(session?.sensorScores).toMatchObject({ lateSignOff: true });

    expect(h.lifecycleEvents().map((e) => e.type)).toEqual(['approved', 'closed']);
  });

  it('is refused while the transcript is still finalizing', async () => {
    const h = makeHarness(consultation({ status: ConsultationStatus.CLOSED_INCOMPLETE, processing: ConsultationProcessing.FINALIZING_TRANSCRIPT }));
    expect(conflictCode(await rejectionOf(h.service.approve(ID, { expectedVersion: 5, caller })))).toBe('CONSULTATION_PROCESSING_IN_FLIGHT');
  });
});
