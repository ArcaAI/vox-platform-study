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
  grantId?: string;
  expiresAt?: Date | null;
}

/**
 * The ABAC evaluation choke point (TASK-712, consent-abac). One
 * implementation, callable identically from HTTP guards, BullMQ workers,
 * Temporal activities, and tool layers — none of which are wired to call it
 * in this phase (see consent-design.md). Fail-closed by construction: no
 * grant, an expired grant, a revoked grant, or a grant whose `scope` does
 * not cover the request all deny; there is no enable/disable switch.
 */
export interface IConsultationConsentService {
  /** Resolves on an active, sufficiently-scoped grant; throws `ConsentDeniedException` otherwise. */
  assertConsent(input: ConsentAssertInput): Promise<void>;
  /** Same evaluation as `assertConsent`, returned as a decision for callers that must branch instead of throw. */
  checkConsent(input: ConsentAssertInput): Promise<ConsentDecision>;
}
export const IConsultationConsentService = Symbol('IConsultationConsentService');
