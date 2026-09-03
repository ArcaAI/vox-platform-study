import { CONSENT_UNAVAILABLE, BaseDomainException } from '../common';

/**
 * Structured detail carried by a {@link ConsentUnavailableException}.
 * Deliberately narrower than {@link ConsentDeniedException}'s metadata — an
 * unavailability verdict has no `reason` in the business sense (no_grant /
 * expired / revoked / scope_insufficient); it has an infrastructure cause.
 */
export interface ConsentUnavailableMetadata {
  tenantId: string;
  externalPatientId: string;
  purpose: string;
  /** The underlying failure, for operator diagnosis — never PHI. */
  cause: string;
}

/**
 * Thrown by `assertConsent` (`packages/applications/src/services/consent/`)
 * when the grant lookup itself failed (an unreachable dependency, a query
 * error) rather than resolving to a genuine "no active grant" verdict. Still
 * fail-closed — the caller is denied either way — but a `ConsentDeniedException`
 * and a `ConsentUnavailableException` MUST map to different HTTP statuses and
 * different reason codes: a real denial is an expected, un-alarming
 * compliance event; an unavailability denial is a gateway/DB hiccup that
 * happens to look like one, and must not be conflated with genuine consent
 * enforcement in alerting or in the audit trail (R4,
 */
export class ConsentUnavailableException extends BaseDomainException {
  static readonly code = CONSENT_UNAVAILABLE;
  constructor(message: string, metadata: ConsentUnavailableMetadata, cause?: Error) {
    super(message, ConsentUnavailableException.code, cause, metadata);
  }
}
