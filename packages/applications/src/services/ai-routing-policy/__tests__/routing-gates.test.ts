/**
 * The three hard gates — one describe block each.
 *
 * They are tested separately on purpose. "The gates work" is not coverage of
 * three independent PHI boundaries: a single composed assertion passes just as
 * happily when two of the three are dead code, and the failure that matters
 * (one gate quietly stops firing) is exactly the one it cannot see.
 */
import { describe, expect, it } from 'vitest';
import { NO_FALLBACK, RoutingCandidate, RoutingFallbackContract, parseFallback } from '../routing-policy.contract';
import { FundedCandidate, RoutingHopRejection, checkBaaGate, checkFundingGate, checkResidencyGate, evaluateHop } from '../routing-gates';

function candidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    rank: 0,
    weight: 100,
    connectionRef: 'azure',
    model: 'gpt-4o',
    residency: 'AZURE_US',
    baaCovered: true,
    maxTtftMs: null,
    ...overrides,
  };
}

const ENGAGED: RoutingFallbackContract = { ...NO_FALLBACK, maxDepth: 3 };

describe('GATE 1 — same residency class', () => {
  it('admits a hop that stays inside the primary residency class', () => {
    expect(checkResidencyGate(candidate(), candidate({ connectionRef: 'bedrock' }), ENGAGED)).toBeNull();
  });

  it('REJECTS a hop that leaves the primary residency class', () => {
    const hop = candidate({ connectionRef: 'bedrock', residency: 'AWS_EU' });
    expect(checkResidencyGate(candidate(), hop, ENGAGED)).toBe(RoutingHopRejection.ResidencyClassMismatch);
  });

  it('compares classes for EQUALITY and knows no taxonomy of its own', () => {
    // A label neither the code nor a migration has ever seen still works, in
    // both directions. That is the point of keeping residency opaque.
    const primary = candidate({ residency: 'SOVEREIGN_IN_MUMBAI_2029' });
    expect(checkResidencyGate(primary, candidate({ residency: 'SOVEREIGN_IN_MUMBAI_2029' }), ENGAGED)).toBeNull();
    expect(checkResidencyGate(primary, candidate({ residency: 'AZURE_US' }), ENGAGED)).toBe(RoutingHopRejection.ResidencyClassMismatch);
  });

  it('is relaxed only by an EXPLICIT false from the policy author', () => {
    const hop = candidate({ residency: 'AWS_EU' });
    expect(checkResidencyGate(candidate(), hop, { requireSameResidencyClass: false })).toBeNull();
  });
});

describe('GATE 2 — BAA-covered target', () => {
  it('admits a covered hop', () => {
    expect(checkBaaGate(candidate({ baaCovered: true }), ENGAGED)).toBeNull();
  });

  it('REJECTS an uncovered hop', () => {
    expect(checkBaaGate(candidate({ baaCovered: false }), ENGAGED)).toBe(RoutingHopRejection.NotBaaCovered);
  });

  it('judges the HOP alone — an uncovered primary is not a licence to hop to an uncovered target', () => {
    // Coverage is per-vendor AND per-model (AWS lists Bedrock "excluding Fable
    // and Mythos models"), so "the primary was also uncovered" is not a defence.
    expect(checkBaaGate(candidate({ baaCovered: false }), ENGAGED)).toBe(RoutingHopRejection.NotBaaCovered);
  });

  it('is relaxed only by an EXPLICIT false from the policy author', () => {
    expect(checkBaaGate(candidate({ baaCovered: false }), { requireBaaCovered: false })).toBeNull();
  });
});

describe('GATE 3 — same funding tier', () => {
  it('admits a hop that stays on the same tier', () => {
    expect(checkFundingGate('BYOK', 'BYOK', ENGAGED)).toBeNull();
    expect(checkFundingGate('CLOUD', 'CLOUD', ENGAGED)).toBeNull();
  });

  it('REJECTS a BYOK -> CLOUD hop (it moves the charge onto the platform P&L)', () => {
    expect(checkFundingGate('BYOK', 'CLOUD', ENGAGED)).toBe(RoutingHopRejection.FundingTierMismatch);
  });

  it('REJECTS a CLOUD -> BYOK hop too — the gate is symmetric', () => {
    expect(checkFundingGate('CLOUD', 'BYOK', ENGAGED)).toBe(RoutingHopRejection.FundingTierMismatch);
  });

  it('is relaxed only by an EXPLICIT crossFundingAllowed', () => {
    expect(checkFundingGate('BYOK', 'CLOUD', { crossFundingAllowed: true })).toBeNull();
  });
});

describe('evaluateHop — composition', () => {
  const funded = (c: RoutingCandidate, funding: FundedCandidate['funding']): FundedCandidate => ({ candidate: c, funding });

  it('admits a hop that clears all three gates', () => {
    expect(evaluateHop(funded(candidate(), 'BYOK'), funded(candidate({ connectionRef: 'bedrock' }), 'BYOK'), ENGAGED)).toBeNull();
  });

  it('reports the FIRST failing gate so the message names one actionable cause', () => {
    const hop = candidate({ residency: 'AWS_EU', baaCovered: false });
    expect(evaluateHop(funded(candidate(), 'BYOK'), funded(hop, 'CLOUD'), ENGAGED)).toBe(RoutingHopRejection.ResidencyClassMismatch);
  });

  it('refuses a hop whose connection resolved to no credential tier at all', () => {
    expect(evaluateHop(funded(candidate(), 'BYOK'), funded(candidate(), null), ENGAGED)).toBe(RoutingHopRejection.ConnectionUnresolved);
  });

  it('never admits a hop because the funding CHECK was unavailable', () => {
    // The primary's own connection did not resolve, so gate 3 has no anchor.
    // Skipping it would admit the hop on a missing check rather than a passing
    // one — fail closed instead.
    expect(evaluateHop(funded(candidate(), null), funded(candidate(), 'CLOUD'), ENGAGED)).toBe(RoutingHopRejection.FundingTierMismatch);
  });
});

describe('parseFallback — absence is fail-closed', () => {
  it('treats an absent contract as NO fallback with every gate engaged', () => {
    expect(parseFallback(undefined)).toEqual(NO_FALLBACK);
    expect(parseFallback(null)).toEqual(NO_FALLBACK);
    expect(parseFallback('not an object')).toEqual(NO_FALLBACK);
    expect(NO_FALLBACK.maxDepth).toBe(0);
  });

  it('does not relax a gate on a truthy-but-not-false value', () => {
    const parsed = parseFallback({ maxDepth: 2, requireSameResidencyClass: 'false', requireBaaCovered: 0, crossFundingAllowed: 'yes' });
    expect(parsed.requireSameResidencyClass).toBe(true);
    expect(parsed.requireBaaCovered).toBe(true);
    expect(parsed.crossFundingAllowed).toBe(false);
  });

  it('clamps a negative or non-integer maxDepth to 0 rather than guessing', () => {
    expect(parseFallback({ maxDepth: -1 }).maxDepth).toBe(0);
    expect(parseFallback({ maxDepth: 1.5 }).maxDepth).toBe(0);
  });
});
