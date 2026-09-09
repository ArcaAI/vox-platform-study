import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY, PLATFORM_GUARDRAIL_AVAILABILITY_ID } from '../18-guardrail-availability';
import { SYSTEM_TENANT_ID } from './../00-constants';

/**
 * The seed cannot import `PLATFORM_DEFAULT_GUARDRAIL_POLICIES` from the
 * applications layer (a seed never depends on it — the `16-ai-routing-policy.ts`
 * convention, and `@arcaai/database` does not depend on `@arcaai/applications`
 * in the first place). It is therefore pinned against the SAME cross-language
 * contract fixture the applications catalogue and `apps/guardrail`'s
 * `core/availability.py` are pinned against — one artifact, three readers, so
 * the mirror cannot drift in any direction without a red suite.
 */
const CONTRACT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../../../apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json', import.meta.url)),
    'utf8',
  ),
) as { policies: { id: string; threshold?: { field: string; minimum: number; maximum: number } }[] };

describe('TASK-886 — the SYSTEM guardrail availability seed', () => {
  it('names exactly the policies the contract declares', () => {
    expect(Object.keys(PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY).sort()).toEqual(CONTRACT.policies.map((p) => p.id).sort());
  });

  // TASK-932 (owner decision, 2026-09-09): the two OUTBOUND judges that false-positive on
  // clinical notes — `response_toxicity` (the 300M classifier flags chest pain / aspirin as
  // toxic) and `pii_leak` (a finalized note legitimately re-states the encounter's own
  // identifiers) — ship OFF at the platform tier until they are retuned for clinical text.
  // Every other declared check stays ON.
  const CALIBRATED_OFF = ['response_toxicity', 'pii_leak', 'response_safety', 'response_refusal', 'jailbreak_detection'] as const;

  it('switches ON every declared check except the five clinical-text judges the owner calibrated OFF', () => {
    for (const policy of CONTRACT.policies) {
      const expected = !(CALIBRATED_OFF as readonly string[]).includes(policy.id);
      expect(PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY[policy.id]?.enabled, policy.id).toBe(expected);
    }
  });

  it('carries pii_leak.minScore = 0.5, verbatim from core/policy.py::_SPECS', () => {
    // `_SPECS['piiLeakMinScore'] = _KeySpec(FAIL_OPEN_TO_DEFAULT, 0.5, 0.0, 1.0)`.
    // Seeding the same number is behaviour-neutral; it exists so the
    // tighten-only floor has something to refuse a loosening write against.
    expect(PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY.pii_leak?.minScore).toBe(0.5);
  });

  it('sets a threshold only where the contract declares one, and within its bounds', () => {
    for (const policy of CONTRACT.policies) {
      const seeded = PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY[policy.id]!;
      const extras = Object.keys(seeded).filter((key) => key !== 'enabled');
      if (!policy.threshold) {
        expect(extras).toEqual([]);
        continue;
      }
      expect(extras).toEqual([policy.threshold.field]);
      const value = (seeded as Record<string, number | boolean | undefined>)[policy.threshold.field] as number;
      expect(value).toBeGreaterThanOrEqual(policy.threshold.minimum);
      expect(value).toBeLessThanOrEqual(policy.threshold.maximum);
    }
  });

  it('owns a stable SYSTEM-tenant id so a re-seed and an operator find the same row', () => {
    expect(PLATFORM_GUARDRAIL_AVAILABILITY_ID).toBe('00000000-0000-0000-0018-000000000001');
    expect(SYSTEM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});
