/**
 * Shared constants for the consent domain (TASK-712, consent-abac).
 */

/**
 * In-process invalidation event. `ConsentGrantService` emits this on
 * create/revoke; `ConsultationConsentService` listens (`@OnEvent`) and evicts
 * the matching cache entry — the `OriginRegistryService` within-node
 * precedent (`.claude/rules/09-infrastructure-devops.md` §Config caches).
 *
 * NOT a cross-process Redis channel — see consent-design.md §4. There is no
 * second process to invalidate yet in this phase (no gateway-internal
 * endpoint, no harness client).
 */
export const CONSENT_INVALIDATE_EVENT = 'consent.invalidate';

/**
 * Q3 (HUMAN-GATED, consent-design.md §"Secondary open questions") — the
 * ticket's stated default: trim only, exact-case match. A single shared
 * function so both the write path (`ConsentGrantService`) and the read path
 * (`ConsultationConsentService`) normalize identically; a mismatch fails
 * closed (denied) rather than silently matching a differently-cased id.
 */
export function normalizeExternalPatientId(externalPatientId: string): string {
  return externalPatientId.trim();
}
