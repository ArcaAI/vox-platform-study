/**
 * Guardrail types for the SDK surface (TASK-1050). Wire types come from `@arcaai/types` (a `devDependency`
 * whose declarations the build inlines); the runtime constants live in `core/run-protocol.ts`, which keeps the
 * package at zero runtime dependencies.
 */

import type {
  GuardrailAcknowledgementVia,
  GuardrailApproveRequestAdditions,
  GuardrailApproveResponseAdditions,
  GuardrailHoldResolution,
  GuardrailNotice,
  GuardrailNoticeAcknowledgement,
  HoldResolution,
} from '@arcaai/types';

export type {
  GuardrailAcknowledgementVia,
  GuardrailApproveRequestAdditions,
  GuardrailApproveResponseAdditions,
  GuardrailHoldResolution,
  GuardrailNotice,
  GuardrailNoticeAcknowledgement,
  HoldResolution,
};

/**
 * Added to a successful generate / run / summary-job result. Both are absent on a gateway that predates
 * TASK-1050 and empty when nothing was flagged, so read them as `?? []`.
 */
export interface GuardrailResultFields {
  /** Every warn / unverified notice the operation raised. Show them, then carry on. */
  guardrailNotices?: readonly GuardrailNotice[];
  /** One per request x direction; quote them to support when a verdict needs explaining. */
  guardrailEvaluationIds?: readonly string[];
}

/** The processing reasons of a resumable guardrail hold (mirror of `@arcaai/types` `GUARDRAIL_HOLD_PROCESSING_REASONS`). */
export const GUARDRAIL_HOLD_PROCESSING_REASONS = ['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE'] as const;
export type GuardrailHoldProcessingReason = (typeof GUARDRAIL_HOLD_PROCESSING_REASONS)[number];

/** `true` when `reason` is a guardrail hold: the consultation waits for a resume (or an approve with `resolveHold`). */
export function isGuardrailHoldReason(reason: string | null | undefined): reason is GuardrailHoldProcessingReason {
  return typeof reason === 'string' && (GUARDRAIL_HOLD_PROCESSING_REASONS as readonly string[]).includes(reason);
}

/** What `GET consultations/:id/guardrail-notices` answers. */
export interface GuardrailNoticesResponse {
  readonly notices: readonly GuardrailNotice[];
  /** Notice ids still awaiting an acknowledgement. Absent on a gateway that does not report it. */
  readonly unacknowledgedNoticeIds?: readonly string[];
}

/** Options for {@link ConsultationHandle.approve} on top of the existing ones. */
export type ApproveGuardrailOptions = GuardrailApproveRequestAdditions;
