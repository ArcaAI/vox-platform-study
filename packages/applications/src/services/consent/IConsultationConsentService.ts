import { ConsentPurpose } from '@arcaai/domains';

export interface ConsentAssertActor {
  userId?: string;
  kind: 'user' | 'service' | 'workflow';
}

export interface ConsentAssertContext {
  consultationId?: string;
  toolName?: string;
}

export interface ConsentAssertInput {
  tenantId: string;
  externalPatientId: string;
  purpose: ConsentPurpose;
  scope?: Record<string, unknown>;
  actor: ConsentAssertActor;
  context?: ConsentAssertContext;
}

export type ConsentDenialReason = 'no_grant' | 'expired' | 'revoked' | 'scope_insufficient';

export interface ConsentDecision {
  allowed: boolean;
  reason?: ConsentDenialReason;
  /**
   * Set (and `reason` left undefined) when the verdict could not be
   * determined — the grant-store lookup itself failed — as distinct from a
   * genuine denial. Still `allowed: false` (fail-closed either way), but
   * callers that branch instead of catching `assertConsent`'s exception must
   * be able to tell "denied" from "we could not check" (R4, README §6):
   * different reason code, different alerting, never conflated.
   */
  unavailable?: boolean;
  grantId?: string;
  expiresAt?: Date | null;
}

/**
 * The ABAC evaluation choke point (TASK-712, consent-abac). One
 * implementation, callable identically from HTTP guards, BullMQ workers,
 * Temporal activities, and tool layers. Fail-closed by construction: no
 * grant, an expired grant, a revoked grant, a grant whose `scope` does not
 * cover the request, AND a lookup failure all deny; there is no
 * enable/disable switch. A genuine denial and a lookup failure both deny,
 * but are distinguishable — see {@link ConsentDecision.unavailable} and the
 * two exception types `assertConsent` throws.
 */
export interface IConsultationConsentService {
  /**
   * Resolves on an active, sufficiently-scoped grant. Throws
   * `ConsentDeniedException` (403) on a genuine denial, or
   * `ConsentUnavailableException` (503) when the grant-store lookup itself
   * failed — never the same exception type for both (R4, README §6).
   */
  assertConsent(input: ConsentAssertInput): Promise<void>;
  /** Same evaluation as `assertConsent`, returned as a decision for callers that must branch instead of throw. */
  checkConsent(input: ConsentAssertInput): Promise<ConsentDecision>;
}
export const IConsultationConsentService = Symbol('IConsultationConsentService');
