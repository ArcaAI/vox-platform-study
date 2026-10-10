/**
 * TASK-1059 RC-10 — a new encounter starts with `processing` IDLE.
 *
 * `beginNextEncounter` used to leave the processing axis as the previous encounter's note left it, so
 * the new visit showed the old note's outcome (E2E-41: AWAITING_REVIEW / FAILED / IDLE + NOTE_READY).
 * The rule mirrors `stop`: only work still IN FLIGHT survives (SUMMARIZING, PROCESSING_ATTACHMENT — and
 * FINALIZING_TRANSCRIPT, which the stop flow itself owns); a note outcome is reset. A real guardrail
 * hold (AWAITING_REVIEW with GUARDRAIL_HOLD / EGRESS_REDACTION_UNAVAILABLE) is NEVER cleared by an
 * append: only a resume or an approve resolves it.
 */
import { describe, it, expect } from 'vitest';
import { ConsultationEntity, IConsultationEntity } from '../generated/core/ConsultationEntity';
import { ConsultationProcessing, ConsultationStatus, ResourceStatusType } from '../../enums';

const S = ConsultationStatus;
const P = ConsultationProcessing;

function entity(overrides: Partial<IConsultationEntity> = {}): ConsultationEntity {
  return new ConsultationEntity({
    id: 'c-1',
    tenantId: 't-1',
    patientId: 'p-1',
    appointmentDate: new Date('2026-10-05'),
    doctorId: 'd-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: S.STOPPED,
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
  } as IConsultationEntity);
}

describe('ConsultationEntity.beginNextEncounter — processing reset (RC-10)', () => {
  it.each([
    [P.FAILED, 'NOTE_GENERATION_FAILED'],
    [P.AWAITING_REVIEW, 'NOTE_COVERAGE_GAPS:2'],
    [P.IDLE, 'NOTE_READY'],
  ])('a note outcome (%s / %s) resets to IDLE with no reason', (processing, reason) => {
    const consultation = entity({ processing, processingReason: reason });
    consultation.beginNextEncounter('u-1');
    expect(consultation.processing).toBe(P.IDLE);
    expect(consultation.processingReason).toBeNull();
    // Persisted by the append's OCC write (`updateWithVersion` writes the tracked changes).
    expect(consultation.changes).toHaveProperty('processingReason', null);
  });

  it.each([P.SUMMARIZING, P.PROCESSING_ATTACHMENT, P.FINALIZING_TRANSCRIPT])('work still in flight (%s) survives the append', (processing) => {
    const consultation = entity({ processing, processingReason: null });
    consultation.beginNextEncounter('u-1');
    expect(consultation.processing).toBe(processing);
    expect(consultation.changes).not.toHaveProperty('processing');
  });

  it.each(['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE'])('a real guardrail hold (%s) is never cleared by an append', (reason) => {
    const consultation = entity({ processing: P.AWAITING_REVIEW, processingReason: reason });
    consultation.beginNextEncounter('u-1');
    expect(consultation.processing).toBe(P.AWAITING_REVIEW);
    expect(consultation.processingReason).toBe(reason);
    expect(consultation.changes).not.toHaveProperty('processing');
  });

  it('an already-clean IDLE tracks no processing change', () => {
    const consultation = entity({ status: S.OPEN, processing: P.IDLE, processingReason: null });
    consultation.beginNextEncounter('u-1');
    expect(consultation.processing).toBe(P.IDLE);
    expect(consultation.changes).not.toHaveProperty('processing');
  });
});
