import { ConflictException } from '@nestjs/common';
import { BusinessException } from '@arcaai/exceptions';
import {
  ConsultationLifecycleErrorCode,
  type ConsultationEntity,
  type ConsultationStatus,
  type ConsultationTransitionOptions,
} from '@arcaai/domains';

/**
 * Every 409 the lifecycle answers, by code. The first five mirror the domain guards
 * (`ConsultationLifecycleErrorCode`); the rest are refusals the services make themselves. A client
 * branches on `code`, never on the message.
 */
export const LifecycleConflictCode = {
  TRANSITION_ILLEGAL: ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL,
  PROCESSING_IN_FLIGHT: ConsultationLifecycleErrorCode.PROCESSING_IN_FLIGHT,
  REOPEN_NOT_ALLOWED: ConsultationLifecycleErrorCode.REOPEN_NOT_ALLOWED,
  ENCOUNTER_CAPTURE_ACTIVE: ConsultationLifecycleErrorCode.ENCOUNTER_CAPTURE_ACTIVE,
  CONSULTATION_APPROVED: ConsultationLifecycleErrorCode.CONSULTATION_APPROVED,
  /** Content edit on a CLOSED_INCOMPLETE consultation (reopen it first). */
  CONSULTATION_CLOSED: 'CONSULTATION_CLOSED',
  /** `start` on a consultation that can no longer be recorded (APPROVED / closed). */
  CONSULTATION_NOT_RECORDABLE: 'CONSULTATION_NOT_RECORDABLE',
  /** `start` naming an STT session apps/stt reports as not active. */
  STT_SESSION_NOT_ACTIVE: 'STT_SESSION_NOT_ACTIVE',
  /** TASK-1050 — `start` on a consultation in a guardrail hold: resume the hold first. */
  GUARDRAIL_HOLD: 'GUARDRAIL_HOLD',
} as const;
export type LifecycleConflictCode = (typeof LifecycleConflictCode)[keyof typeof LifecycleConflictCode];

export function lifecycleConflict(code: LifecycleConflictCode, message: string, details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ code, message, ...details });
}

/**
 * Translate a domain lifecycle refusal into its coded 409. Anything else is rethrown untouched.
 */
export function toLifecycleConflict(error: unknown): unknown {
  if (!(error instanceof BusinessException)) return error;
  const metadata = (error.metadata ?? {}) as Record<string, unknown>;
  const code = typeof metadata.code === 'string' ? metadata.code : LifecycleConflictCode.TRANSITION_ILLEGAL;
  const { code: _code, ...details } = metadata;
  return new ConflictException({ code, message: error.message, ...details });
}

/** `entity.transitionTo` with the refusal mapped to its coded 409. */
export function applyLifecycleTransition(
  entity: ConsultationEntity,
  next: ConsultationStatus,
  actor: string,
  reason: string,
  options: ConsultationTransitionOptions = {},
): boolean {
  try {
    return entity.transitionTo(next, actor, reason, options);
  } catch (error) {
    throw toLifecycleConflict(error);
  }
}
