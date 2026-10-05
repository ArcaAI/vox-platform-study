import type { CaptureState, ConsultationProcessing, ConsultationStatus } from '@arcaai/types';
import { ConsultationStatus as Status, type ConsultationEntity } from '@arcaai/domains';

/** The capture view of a consultation row, as `start` / `pause` / `stop` answer it. */
export function toCaptureState(entity: ConsultationEntity, sessionId?: string): CaptureState {
  return {
    consultationId: entity.id,
    status: entity.status as ConsultationStatus,
    processing: entity.processing as ConsultationProcessing,
    encounterSeq: entity.currentEncounterSeq,
    ...(sessionId ? { sessionId } : {}),
    recording: entity.status === Status.RECORDING,
    paused: entity.status === Status.PAUSED,
    version: entity.version,
    updatedAt: (entity.updatedAt ?? new Date()).toISOString(),
  };
}
