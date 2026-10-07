/**
 * Guardrail hold, resume and the one-action approve (TASK-1050 W1; README §9.7.5, §9.8.1, §9.8.3).
 *
 * A `block` inside a consultation is a HOLD, never a dead end: `status` PAUSED, `processing` AWAITING_REVIEW,
 * `processingReason` GUARDRAIL_HOLD (or EGRESS_REDACTION_UNAVAILABLE), the `noticeId` recorded. It is resolved
 * by `POST consultations/:id/guardrail-hold/resume` (If-Match) or, in one action, by `approve` with
 * `resolveHold` (inbound holds only, OD-24).
 */

/**
 * - `item_excluded`: the BLOCKED items are left out of every later LLM context (they stay in the record).
 * - `item_edited`: the clinician corrected the item; the new version is unmarked and re-screened.
 * - `acknowledged`: override — proceed once for this notice at warn weight, recorded as `SAFETY_OVERRIDE`.
 *   Not offered for a check whose platform floor is `block` (the locked medical check).
 */
export const GUARDRAIL_HOLD_RESOLUTIONS = ['item_excluded', 'item_edited', 'acknowledged'] as const;
export type HoldResolution = (typeof GUARDRAIL_HOLD_RESOLUTIONS)[number];

export interface GuardrailHoldResolution {
  readonly noticeId: string;
  readonly resolution: HoldResolution;
}

/** Body of `POST consultations/:id/guardrail-hold/resume` (If-Match on the consultation, audited). */
export type GuardrailHoldResumeRequest = GuardrailHoldResolution;

/** Route template (under the global `api/v1` prefix). */
export const GUARDRAIL_HOLD_RESUME_PATH = 'consultations/:id/guardrail-hold/resume';

export function guardrailHoldResumePath(consultationId: string): string {
  return GUARDRAIL_HOLD_RESUME_PATH.replace(':id', encodeURIComponent(consultationId));
}

/** Fields `POST consultations/:id/approve` gains (README §9.8.3). Approve is never refused because of warnings. */
export interface GuardrailApproveRequestAdditions {
  /**
   * The client showed the outstanding warnings in its confirm step. Either way every outstanding warning on
   * the approved items is acknowledged atomically in the approve transaction.
   */
  readonly acknowledgeGuardrailNotices?: boolean;
  /** Resolve an (inbound) hold and approve in the same transaction. */
  readonly resolveHold?: GuardrailHoldResolution;
}

/** How a notice came to be acknowledged. */
export const GUARDRAIL_ACKNOWLEDGEMENT_VIAS = ['ack', 'approve', 'resume'] as const;
export type GuardrailAcknowledgementVia = (typeof GUARDRAIL_ACKNOWLEDGEMENT_VIAS)[number];

export interface GuardrailNoticeAcknowledgement {
  readonly noticeId: string;
  /** The user id of the approver / clinician. */
  readonly acknowledgedBy: string;
  readonly acknowledgedVia: GuardrailAcknowledgementVia;
  /** ISO-8601 UTC. */
  readonly acknowledgedAt: string;
}

/** Fields the approve response gains. The notice ids also go into the signed `ConsultationApproval` snapshot. */
export interface GuardrailApproveResponseAdditions {
  readonly acknowledgedNotices: readonly GuardrailNoticeAcknowledgement[];
}
