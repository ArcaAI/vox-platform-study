import { RoutingCandidate, RoutingFallbackContract } from './routing-policy.contract';

/**
 * the three hard gates, as pure functions.
 *
 * > **Three hard gates on any hop, enforced in code, not in policy text**: same
 * > residency class, BAA-covered target, same funding tier. A hop crossing any
 * > of them is **not a fallback — it is a rejection.**
 *
 * "Enforced in code, not in policy text" is the load-bearing phrase. Each gate
 * is a function that RUNS on every hop and returns a machine-readable reason,
 * not a sentence in a runbook that a reviewer is trusted to have read. They are
 * separate exported functions rather than one `checkHop()` so each rejection
 * can be pinned by its own test — "the gates work" is not coverage of three
 * independent PHI boundaries.
 *
 * They are pure and take no repository, no CLS and no clock, so the service
 * cannot accidentally make one of them conditional on request state.
 */

/** Which tier paid for the credential a candidate will spend. */
export type RoutingFunding = 'BYOK' | 'CLOUD';

/**
 * Why a hop is not permitted. Machine-readable: the router turns this into the
 * `x-hope-fallback-reason` header and the `fallback_occurred` sys-event of
 * and a super admin reads it back off `GET .../effective`.
 */
export enum RoutingHopRejection {
  /** Gate 1 — the hop leaves the primary's residency class. */
  ResidencyClassMismatch = 'RESIDENCY_CLASS_MISMATCH',
  /** Gate 2 — the hop's target is not BAA-covered for this vendor AND model. */
  NotBaaCovered = 'NOT_BAA_COVERED',
  /** Gate 3 — the hop moves the charge between BYOK and platform CLOUD. */
  FundingTierMismatch = 'FUNDING_TIER_MISMATCH',
  /** The chain's `maxDepth` is already spent. */
  FallbackDepthExceeded = 'FALLBACK_DEPTH_EXCEEDED',
  /** No credential tier serves this candidate's connection for this tenant. */
  ConnectionUnresolved = 'CONNECTION_UNRESOLVED',
  /** The router reported this provider as ejected/unhealthy. */
  ProviderUnhealthy = 'PROVIDER_UNHEALTHY',
  /** `explicitProvider.mode = STRICT` — the chain is closed by ruling. */
  ExplicitProviderStrict = 'EXPLICIT_PROVIDER_STRICT',
}

/**
 * GATE 1 — same residency class.
 *
 * Equality on an opaque label, never membership of a list this layer knows.
 * A policy MAY relax it (`requireSameResidencyClass: false`), which is an
 * explicit, audited act by a super admin; absence leaves it engaged.
 */
export function checkResidencyGate(
  primary: Pick<RoutingCandidate, 'residency'>,
  hop: Pick<RoutingCandidate, 'residency'>,
  contract: Pick<RoutingFallbackContract, 'requireSameResidencyClass'>,
): RoutingHopRejection | null {
  if (!contract.requireSameResidencyClass) return null;
  return hop.residency === primary.residency ? null : RoutingHopRejection.ResidencyClassMismatch;
}

/**
 * GATE 2 — BAA-covered target.
 *
 * Judged on the HOP alone, not relative to the primary: a hop from one covered
 * vendor to an uncovered one is the failure mode, and "the primary was also
 * uncovered" is not a defence. 's evidence is that coverage is per-vendor
 * AND per-model (AWS lists Bedrock "excluding Fable and Mythos models"), which
 * is why `baaCovered` sits on the CANDIDATE — the vendor alone cannot answer it.
 */
export function checkBaaGate(
  hop: Pick<RoutingCandidate, 'baaCovered'>,
  contract: Pick<RoutingFallbackContract, 'requireBaaCovered'>,
): RoutingHopRejection | null {
  if (!contract.requireBaaCovered) return null;
  return hop.baaCovered ? null : RoutingHopRejection.NotBaaCovered;
}

/**
 * GATE 3 — same funding tier.
 *
 * Both operands are DERIVED by the caller from the row that supplied the
 * credential (`row.tenantId === SYSTEM_TENANT_ID`), exactly as
 * `AiProviderConnectionService.fundingOf` does it — this function takes the
 * labels, it does not compute them, so there is no second notion of funding to
 * drift from the first. Failing over from a tenant's own key to a SYSTEM
 * credential moves the charge onto the platform's P&L and flips the metering
 * class mid-request (; getting it wrong is silent, because the wrong
 * label still produces a self-consistent ledger pair.
 */
export function checkFundingGate(
  primaryFunding: RoutingFunding,
  hopFunding: RoutingFunding,
  contract: Pick<RoutingFallbackContract, 'crossFundingAllowed'>,
): RoutingHopRejection | null {
  if (contract.crossFundingAllowed) return null;
  return hopFunding === primaryFunding ? null : RoutingHopRejection.FundingTierMismatch;
}

/** One candidate paired with the funding tier its connection resolves to. */
export interface FundedCandidate {
  candidate: RoutingCandidate;
  /** `null` when no credential tier serves this connection for the tenant. */
  funding: RoutingFunding | null;
}

/**
 * Compose the three gates for one hop, in a fixed order.
 *
 * Order is deliberate and reported: an unresolvable connection is diagnosed
 * before any gate (there is nothing to compare), then residency, BAA, funding.
 * The FIRST reason is returned, so a rejection message names one actionable
 * cause rather than a set.
 */
export function evaluateHop(primary: FundedCandidate, hop: FundedCandidate, contract: RoutingFallbackContract): RoutingHopRejection | null {
  if (hop.funding === null) return RoutingHopRejection.ConnectionUnresolved;
  const residency = checkResidencyGate(primary.candidate, hop.candidate, contract);
  if (residency) return residency;
  const baa = checkBaaGate(hop.candidate, contract);
  if (baa) return baa;
  // A primary whose own connection did not resolve cannot anchor a funding
  // comparison. Treat that as a funding mismatch rather than silently skipping
  // gate 3 — a hop must never be admitted because the CHECK was unavailable.
  if (primary.funding === null) return RoutingHopRejection.FundingTierMismatch;
  return checkFundingGate(primary.funding, hop.funding, contract);
}
