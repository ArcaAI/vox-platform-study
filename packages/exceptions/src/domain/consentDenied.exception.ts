import { CONSENT_DENIED, BaseDomainException } from '../common';

/**
 * Structured detail carried by a {@link ConsentDeniedException} so the
 * gateway can render a precise 403 body and callers can distinguish an
 * absent grant from an expired/revoked/scope-insufficient one without
 * parsing the message string.
 */
export interface ConsentDeniedMetadata {
  tenantId: string;
  externalPatientId: string;
  purpose: string;
  /** Why the assertion denied — machine-readable, stable values. */
  reason: 'no_grant' | 'expired' | 'revoked' | 'scope_insufficient';
  grantId?: string;
}

/**
 * Thrown by `assertConsent` (`packages/applications/src/services/consent/`)
 * when the caller has no active, sufficiently-scoped `ConsentGrant` for the
 * requested `(tenantId, externalPatientId, purpose)`. Fail-closed by
 * construction — there is no kill-switch that widens this to "allow"; see
 * `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers.
 *
 * NOT wired to any HTTP route, guard, or Temporal activity in TASK-712's
 * reduced-scope pass — see
 * docs/implementation/TASK-712-Consent-Abac/consent-design.md.
 */
export class ConsentDeniedException extends BaseDomainException {
  static readonly code = CONSENT_DENIED;
  constructor(message: string, metadata: ConsentDeniedMetadata, cause?: Error) {
    super(message, ConsentDeniedException.code, cause, metadata);
  }
}
