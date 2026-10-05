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

/**
 * Project a lifecycle state onto the status an older client (ALaaS 4.1) understands.
 *
 * PAUSED reads as RECORDING (older clients have no pause); STOPPED splits by what the platform
 * is doing — summarizing reads DRAFT_PENDING_SENSORS, a draft waiting for (or failed before)
 * review reads PENDING_REVIEW, anything else reads DRAINING; APPROVED reads SIGNED. Every other
 * value exists in both vocabularies and is returned as is.
 */
export function projectLegacyConsultationStatus(status: ConsultationStatus, processing: ConsultationProcessing): LegacyConsultationStatus {
  switch (status) {
    case 'PAUSED':
      return 'RECORDING';
    case 'STOPPED':
      if (processing === 'SUMMARIZING') return 'DRAFT_PENDING_SENSORS';
      if (processing === 'AWAITING_REVIEW' || processing === 'FAILED') return 'PENDING_REVIEW';
      return 'DRAINING';
    case 'APPROVED':
      return 'SIGNED';
    default:
      return status;
  }
}
