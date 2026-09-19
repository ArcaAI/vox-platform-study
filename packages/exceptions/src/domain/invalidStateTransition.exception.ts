import { INVALID_STATE_TRANSITION, BaseDomainException } from '../common';

/**
 * Structured detail carried by an {@link InvalidStateTransitionException} so a
 * caller in ANOTHER PROCESS can decide what to do without parsing the message.
 *
 * That is the whole point of this type. The STT worker used to classify a
 * refused `PATCH /internal/stt/jobs/:id/start` by substring-matching
 * `"Cannot start job in"` on a generic `500 DOMAIN.BUSINESS` body — which made
 * a recoverable `PROCESSING` indistinguishable from a genuinely finished
 * `COMPLETED`, and orphaned every job whose worker died mid-flight (TASK-992).
 */
export interface InvalidStateTransitionMetadata {
  /** The aggregate whose state machine refused, e.g. `TranscriptionJob`. */
  entity: string;
  /** The row the transition was attempted on. */
  entityId: string;
  /** The status the row is actually in. */
  currentStatus: string;
  /** The transition that was attempted, e.g. `startProcessing`. */
  attempted: string;
  /**
   * Whether {@link currentStatus} admits ANY further transition.
   *
   * Deliberately a boolean decided HERE rather than a status string the caller
   * re-interprets: the gateway owns the state machine, so terminality is its
   * answer to give. A consumer that has to maintain its own copy of "which
   * statuses are terminal" is one release away from disagreeing with the
   * server — which is exactly the bug this exception replaces.
   */
  terminal: boolean;
}

/**
 * Thrown when an aggregate's state machine refuses a transition because of the
 * status the row is currently in — as opposed to an invalid argument
 * (`ArgumentInvalidException`, 400) or a version conflict
 * (`OptimisticConcurrencyException`, 412).
 *
 * The API gateway maps this to **409 Conflict**: the request is well-formed and
 * the caller is authorised, but the resource's current state conflicts with it.
 * A plain `BusinessException` would fall through to the generic 500 branch of
 * `ExceptionInterceptor`, which is both the wrong status and — because
 * `DOMAIN.BUSINESS` is shared by every business refusal in the platform —
 * unreadable to a machine caller.
 */
export class InvalidStateTransitionException extends BaseDomainException {
  static readonly code = INVALID_STATE_TRANSITION;
  constructor(message: string, metadata: InvalidStateTransitionMetadata, cause?: Error) {
    super(message, InvalidStateTransitionException.code, cause, metadata);
  }
}
