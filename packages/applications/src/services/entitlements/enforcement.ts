/**
 * Pure enforcement logic (Q10 + Q4).
 *
 * Kept free of NestJS/DB so the sensitive "block-new" comparison, the
 * newest-first soft-disable selection, and the trial-expiry predicate are
 * exhaustively unit-testable. The `EntitlementsService` / lifecycle jobs supply
 * the resolved limits, live counts, and persistence.
 */

import { ResolvedLimits } from './resolve-entitlements';

/** A capability that carries a numeric limit (a key of the resolved limits). */
export type EntitlementLimitKey = keyof ResolvedLimits;

/**
 * The rolling-monthly METER capabilities (Q5): the subset of limit keys backed
 * by `TenantUsageMeter` / live Postgres aggregation. Over-limit here maps to
 * HTTP 429 (not 409) at the API gateway.
 *
 * Adds the five ledger-derived unit-allowance capabilities.
 * Deliberately NO `monthlyGuardrailCalls` — guardrail has no allowance column
 * (D6/D16: metered, never quota-blocked), so the type itself makes
 * "gate a guardrail call on quota" impossible to express at a call site.
 */
export type MeterCapabilityKey =
  | 'monthlyConsultations'
  | 'monthlyTranscriptionMinutes'
  | 'monthlySummaries'
  | 'monthlyWorkflowInvocations'
  | 'monthlySttSessionSeconds'
  | 'monthlyLlmTokens'
  | 'monthlyTtsCharacters'
  | 'monthlyNlpTextUnits'
  | 'monthlyEmbeddingTokens';

/**
 * Q10 "block-new" — would adding `increment` more (default 1) to `used` exceed
 * `limit`? A `null` limit is unlimited (incl. ungated-legacy, Q3) and never
 * exceeds. Existing usage at/over the limit still blocks the NEXT create.
 */
export function wouldExceedLimit(limit: number | null, used: number, increment = 1): boolean {
  if (limit === null) return false;
  return used + increment > limit;
}

/** One existing resource considered for Q10 soft-disable. */
export interface DisableCandidate {
  id: string;
  createdAt: Date;
}

/**
 * Q10 — choose which resources to SOFT-DISABLE when a tenant's limit for a
 * capability drops below its current count (an explicit downgrade). Keeps the
 * OLDEST `limit` enabled (grandfathered) and returns the NEWEST overflow ids to
 * disable (a reversible status flip — the caller NEVER deletes). Returns `[]`
 * when already within limit or when the limit is `null` (unlimited).
 *
 * Determinism: sorts by `createdAt` ascending, tie-breaking on `id` so the same
 * inputs always yield the same selection (important for a re-runnable job).
 */
export function selectResourcesToDisable(resources: DisableCandidate[], limit: number | null): string[] {
  if (limit === null || limit < 0) return [];
  if (resources.length <= limit) return [];

  const oldestFirst = [...resources].sort((a, b) => {
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });

  return oldestFirst.slice(limit).map((r) => r.id);
}

/**
 * Q4 — has a trial clock elapsed? `trialEndsAt <= now`. Null clock (non-trial or
 * unset) is never expired. The trial-expiry job additionally filters
 * `plan === TRIAL` before flipping the plan to STARTER.
 */
export function isTrialExpired(trialEndsAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt.getTime() <= now.getTime();
}
