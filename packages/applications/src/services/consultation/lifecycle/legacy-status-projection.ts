import type { ConsultationProcessing, ConsultationStatus, LegacyConsultationStatus } from '@arcaai/types';

/**
 * The request header a client sends to read the seven-value lifecycle vocabulary in the JSON
 * `status` field. Without it the API layer projects `status` onto the old twelve-value
 * vocabulary with {@link projectLegacyConsultationStatus}; the real value is always also
 * returned under `lifecycle: { status, processing }`.
 */
export const HOPE_LIFECYCLE_HEADER = 'x-hope-lifecycle';
export const HOPE_LIFECYCLE_VERSION = '2';

/** True when the request opted into the lifecycle vocabulary. */
export function wantsLifecycleVocabulary(headerValue: string | string[] | undefined | null): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === 'string' && value.trim() === HOPE_LIFECYCLE_VERSION;
}

/** The `processingReason` a written harness note leaves with processing IDLE: the note waits for the clinician. */
export const NOTE_READY_REASON = 'NOTE_READY';

/**
 * Project a lifecycle state onto the status an older client (ALaaS 4.1) understands.
 *
 * PAUSED reads as RECORDING (older clients have no pause); STOPPED splits by what the platform
 * is doing — summarizing reads DRAFT_PENDING_SENSORS, a note waiting for review (IDLE with
 * reason {@link NOTE_READY_REASON}, or AWAITING_REVIEW) or failed reads PENDING_REVIEW, anything
 * else reads DRAINING; APPROVED reads SIGNED. Every other value exists in both vocabularies and is
 * returned as is.
 */
export function projectLegacyConsultationStatus(
  status: ConsultationStatus,
  processing: ConsultationProcessing,
  processingReason?: string | null,
): LegacyConsultationStatus {
  switch (status) {
    case 'PAUSED':
      return 'RECORDING';
    case 'STOPPED':
      if (processing === 'SUMMARIZING') return 'DRAFT_PENDING_SENSORS';
      if (processing === 'AWAITING_REVIEW' || processing === 'FAILED') return 'PENDING_REVIEW';
      if (processing === 'IDLE' && processingReason === NOTE_READY_REASON) return 'PENDING_REVIEW';
      return 'DRAINING';
    case 'APPROVED':
      return 'SIGNED';
    default:
      return status;
  }
}
