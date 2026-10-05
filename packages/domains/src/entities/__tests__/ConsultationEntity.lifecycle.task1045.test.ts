/**
 * ConsultationEntity — seven-state lifecycle + background processing axis.
 *
 * The transition matrix below is written out as test data (NOT imported from
 * the implementation): one row per legal, non-reflexive edge of the contract
 * matrix. Every other ordered pair of distinct states must be refused with the
 * machine code `CONSULTATION_TRANSITION_ILLEGAL`.
 */
import { describe, it, expect } from 'vitest';
import { BusinessException } from '@arcaai/exceptions';
import { ConsultationEntity, IConsultationEntity, ConsultationLifecycleErrorCode } from '../generated/core/ConsultationEntity';
import { ConsultationClosedReason, ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '../../enums';

const S = ConsultationStatus;
const P = ConsultationProcessing;

const ALL: ConsultationStatus[] = [S.OPEN, S.RECORDING, S.PAUSED, S.STOPPED, S.APPROVED, S.CLOSED_COMPLETE, S.CLOSED_INCOMPLETE];

const LEGAL: Array<[ConsultationStatus, ConsultationStatus]> = [
  [S.OPEN, S.RECORDING],
  [S.OPEN, S.CLOSED_INCOMPLETE],
  [S.RECORDING, S.PAUSED],
  [S.RECORDING, S.STOPPED],
  [S.RECORDING, S.CLOSED_INCOMPLETE],
  [S.PAUSED, S.RECORDING],
  [S.PAUSED, S.STOPPED],
  [S.PAUSED, S.CLOSED_INCOMPLETE],
  [S.STOPPED, S.RECORDING],
  [S.STOPPED, S.OPEN],
  [S.STOPPED, S.APPROVED],
  [S.STOPPED, S.CLOSED_INCOMPLETE],
  [S.APPROVED, S.CLOSED_COMPLETE],
  [S.CLOSED_INCOMPLETE, S.OPEN],
  [S.CLOSED_COMPLETE, S.OPEN],
];

function init(overrides: Partial<IConsultationEntity> = {}): IConsultationEntity {
  return {
    id: 'c-1',
    tenantId: 't-1',
    patientId: 'p-1',
    appointmentDate: new Date('2026-10-05'),
    doctorId: 'd-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: S.OPEN,
    degradedReasons: [],
    createdAt: new Date('2026-10-05'),
    updatedAt: new Date('2026-10-05'),
    createdBy: 'u-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    version: 3,
    ...overrides,
  } as IConsultationEntity;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    return ((error as BusinessException & { metadata?: { code?: string } }).metadata as { code?: string } | undefined)?.code;
  }
  return undefined;
}

describe('ConsultationEntity lifecycle — transition matrix (7 × 7)', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      if (from === to) {
        it(`${from} → ${to} is an idempotent no-op`, () => {
          const entity = new ConsultationEntity(init({ status: from }));
          expect(entity.transitionTo(to, 'u-1', 'test')).toBe(false);
          expect(entity.hasChanges).toBe(false);
          expect(entity.canTransitionTo(to)).toBe(true);
        });
        continue;
      }
      const legal = LEGAL.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to} is ${legal ? 'legal' : 'refused'}`, () => {
        const entity = new ConsultationEntity(init({ status: from }));
        const opts = { allowClosedCompleteReopen: true };
        if (legal) {
          expect(entity.canTransitionTo(to, opts)).toBe(true);
          expect(entity.transitionTo(to, 'u-1', 'test', opts)).toBe(true);
          expect(entity.status).toBe(to);
          expect(entity.lastTransition).toEqual({ from, to, actor: 'u-1', reason: 'test' });
        } else {
          expect(entity.canTransitionTo(to, opts)).toBe(false);
          expect(codeOf(() => entity.transitionTo(to, 'u-1', 'test', opts))).toBe(ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL);
          expect(entity.status).toBe(from);
        }
      });
    }
  }
});

describe('ConsultationEntity lifecycle — guarded edges', () => {
  it('refuses approval while the transcript is finalizing or the note is being generated', () => {
    for (const processing of [P.FINALIZING_TRANSCRIPT, P.SUMMARIZING]) {
      const entity = new ConsultationEntity(init({ status: S.STOPPED, processing }));
      expect(entity.canTransitionTo(S.APPROVED)).toBe(false);
      expect(codeOf(() => entity.transitionTo(S.APPROVED, 'u-1', 'approve'))).toBe(ConsultationLifecycleErrorCode.PROCESSING_IN_FLIGHT);
      expect(entity.status).toBe(S.STOPPED);
    }
  });

  it('allows approval when processing is idle, awaiting review or failed', () => {
    for (const processing of [P.IDLE, P.AWAITING_REVIEW, P.FAILED, P.PROCESSING_ATTACHMENT]) {
      const entity = new ConsultationEntity(init({ status: S.STOPPED, processing, degradedReasons: ['x'] }));
      expect(entity.transitionTo(S.APPROVED, 'u-1', 'approve')).toBe(true);
      expect(entity.approvedAt).toBeInstanceOf(Date);
      expect(entity.degradedReasons).toEqual([]);
      expect(entity.isApproved).toBe(true);
    }
  });

  it('reopens CLOSED_COMPLETE only when the tenant policy allows it', () => {
    const entity = new ConsultationEntity(init({ status: S.CLOSED_COMPLETE, closedReason: ConsultationClosedReason.APPROVED }));
    expect(entity.canTransitionTo(S.OPEN)).toBe(false);
    expect(codeOf(() => entity.transitionTo(S.OPEN, 'u-1', 'reopen'))).toBe(ConsultationLifecycleErrorCode.REOPEN_NOT_ALLOWED);
    expect(entity.transitionTo(S.OPEN, 'u-1', 'reopen', { allowClosedCompleteReopen: true })).toBe(true);
  });

  it('reopen of CLOSED_INCOMPLETE bumps reopenCount and clears the close stamps', () => {
    const entity = new ConsultationEntity(
      init({ status: S.CLOSED_INCOMPLETE, reopenCount: 1, closedAt: new Date(), closedReason: ConsultationClosedReason.AUTO }),
    );
    entity.transitionTo(S.OPEN, 'u-1', 'reopen');
    expect(entity.reopenCount).toBe(2);
    expect(entity.closedAt).toBeNull();
    expect(entity.closedReason).toBeNull();
    expect(entity.reopenAllowed(false)).toBe(false);
  });

  it('closing stamps closedAt and the reason (approved close is APPROVED, otherwise the given reason, default MANUAL)', () => {
    const approved = new ConsultationEntity(init({ status: S.APPROVED }));
    approved.transitionTo(S.CLOSED_COMPLETE, 'u-1', 'close');
    expect(approved.closedReason).toBe(ConsultationClosedReason.APPROVED);
    expect(approved.closedAt).toBeInstanceOf(Date);

    const manual = new ConsultationEntity(init({ status: S.STOPPED }));
    manual.transitionTo(S.CLOSED_INCOMPLETE, 'u-1', 'close');
    expect(manual.closedReason).toBe(ConsultationClosedReason.MANUAL);

    const auto = new ConsultationEntity(init({ status: S.RECORDING }));
    auto.transitionTo(S.CLOSED_INCOMPLETE, 'system', 'auto_close', { closedReason: ConsultationClosedReason.AUTO });
    expect(auto.closedReason).toBe(ConsultationClosedReason.AUTO);
    expect(auto.isClosed).toBe(true);
    expect(auto.reopenAllowed(false)).toBe(true);
  });

  it('recordable is true for OPEN/RECORDING/PAUSED/STOPPED only', () => {
    const recordable = ALL.filter((status) => new ConsultationEntity(init({ status })).isRecordable);
    expect(recordable).toEqual([S.OPEN, S.RECORDING, S.PAUSED, S.STOPPED]);
  });
});

describe('ConsultationEntity lifecycle — encounters', () => {
  it('beginNextEncounter from STOPPED bumps the encounter seq and moves to OPEN', () => {
    const entity = new ConsultationEntity(init({ status: S.STOPPED, currentEncounterSeq: 2 }));
    expect(entity.beginNextEncounter('u-1')).toBe(3);
    expect(entity.currentEncounterSeq).toBe(3);
    expect(entity.status).toBe(S.OPEN);
  });

  it('beginNextEncounter from OPEN bumps the seq and stays OPEN', () => {
    const entity = new ConsultationEntity(init({ status: S.OPEN }));
    expect(entity.currentEncounterSeq).toBe(1);
    expect(entity.beginNextEncounter('u-1')).toBe(2);
    expect(entity.status).toBe(S.OPEN);
  });

  it('beginNextEncounter refuses during capture and after approval', () => {
    for (const status of [S.RECORDING, S.PAUSED]) {
      expect(codeOf(() => new ConsultationEntity(init({ status })).beginNextEncounter('u-1'))).toBe(
        ConsultationLifecycleErrorCode.ENCOUNTER_CAPTURE_ACTIVE,
      );
    }
    expect(codeOf(() => new ConsultationEntity(init({ status: S.APPROVED })).beginNextEncounter('u-1'))).toBe(
      ConsultationLifecycleErrorCode.CONSULTATION_APPROVED,
    );
    expect(codeOf(() => new ConsultationEntity(init({ status: S.CLOSED_INCOMPLETE })).beginNextEncounter('u-1'))).toBe(
      ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL,
    );
  });
});

describe('ConsultationEntity lifecycle — processing axis', () => {
  it('defaults: OPEN, IDLE, encounter 1, cursors 0', () => {
    const entity = new ConsultationEntity(init({ status: undefined }));
    expect(entity.status).toBe(S.OPEN);
    expect(entity.processing).toBe(P.IDLE);
    expect(entity.processingRefs).toEqual([]);
    expect(entity.currentEncounterSeq).toBe(1);
    expect(entity.segmentSeqHead).toBe(0);
    expect(entity.recordingCursorMs).toBe(0);
    expect(entity.reopenCount).toBe(0);
  });

  it('setProcessing keeps the reason only for FAILED / AWAITING_REVIEW and stamps processingUpdatedAt', () => {
    const entity = new ConsultationEntity(init({ status: S.STOPPED }));
    entity.setProcessing(P.FAILED, 'NOTE_INPUT_EXCEEDS_CONTEXT');
    expect(entity.processing).toBe(P.FAILED);
    expect(entity.processingReason).toBe('NOTE_INPUT_EXCEEDS_CONTEXT');
    expect(entity.processingUpdatedAt).toBeInstanceOf(Date);

    entity.setProcessing(P.SUMMARIZING, 'ignored');
    expect(entity.processing).toBe(P.SUMMARIZING);
    expect(entity.processingReason).toBeNull();

    entity.setProcessing(P.AWAITING_REVIEW, 'COVERAGE_GAPS');
    expect(entity.processingReason).toBe('COVERAGE_GAPS');
  });

  it('processing never constrains the status matrix except for approval', () => {
    const entity = new ConsultationEntity(init({ status: S.STOPPED, processing: P.SUMMARIZING }));
    expect(entity.transitionTo(S.RECORDING, 'u-1', 'continue')).toBe(true);
  });

  it('processingReasonFor is the shared clearing rule', () => {
    // IDLE keeps a reason only when one is given (a written note: NOTE_READY); every other IDLE writer passes none.
    expect(ConsultationEntity.processingReasonFor(P.IDLE, 'x')).toBe('x');
    expect(ConsultationEntity.processingReasonFor(P.IDLE)).toBeNull();
    expect(ConsultationEntity.processingReasonFor(P.FAILED, 'x')).toBe('x');
    expect(ConsultationEntity.processingReasonFor(P.AWAITING_REVIEW)).toBeNull();
  });
});
