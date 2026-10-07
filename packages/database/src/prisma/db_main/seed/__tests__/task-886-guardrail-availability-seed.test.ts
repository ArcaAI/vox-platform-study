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
) as { policies: { id: string; defaultEnabled: boolean; threshold?: { field: string; minimum: number; maximum: number } }[] };

/**
 * TASK-1050: the row is written in the v2 shape (`directions` + `checks`); every assertion below reads the
 * per-check entries. The violation-handling fields (`action`, `dataRegionAction`, `locked`) are pinned against
 * the same contract in `task-1050-guardrail-seed.test.ts`.
 */
const CHECKS = PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY.checks;
/** The fields of a v2 check entry that are not a strictness threshold. */
const NON_THRESHOLD_FIELDS = new Set(['enabled', 'action', 'locked', 'dataRegionAction']);

describe('TASK-886 — the SYSTEM guardrail availability seed', () => {
  it('names exactly the policies the contract declares (TASK-1050: +5 — medical validation and the four judges)', () => {
    expect(Object.keys(CHECKS).sort()).toEqual(CONTRACT.policies.map((p) => p.id).sort());
    expect(Object.keys(CHECKS)).toHaveLength(13);
  });

  // Owner decisions OD-1..OD-5 (2026-10-02): guardrails check the request AND the response, so
  // every declared classifier check ships ON. `response_refusal` stays off: a refusal is not unsafe content.
  // TASK-1050 OD-6: the four safety judges ship OFF (a deploy makes zero judge calls); medical validation is ON.
  const CALIBRATED_OFF = ['response_refusal', 'injection_judge', 'unsafe_content_judge', 'clinical_safety_judge', 'leakage_judge'] as const;

  it('switches ON every declared check except response_refusal and the four judges, matching the contract defaults', () => {
    for (const policy of CONTRACT.policies) {
      const expected = !(CALIBRATED_OFF as readonly string[]).includes(policy.id);
      expect(CHECKS[policy.id]?.enabled, policy.id).toBe(expected);
      expect(CHECKS[policy.id]?.enabled, `${policy.id} vs contract defaultEnabled`).toBe(policy.defaultEnabled);
    }
  });

  it('leaves both screening directions on', () => {
    expect(PLATFORM_DEFAULT_GUARDRAIL_AVAILABILITY.directions).toEqual({ inbound: { enabled: true }, outbound: { enabled: true } });
  });

  it('carries pii_leak.minScore = 0.5, verbatim from core/policy.py::_SPECS', () => {
    // `_SPECS['piiLeakMinScore'] = _KeySpec(FAIL_OPEN_TO_DEFAULT, 0.5, 0.0, 1.0)`.
    // Seeding the same number is behaviour-neutral; it exists so the
    // tighten-only floor has something to refuse a loosening write against.
    expect(CHECKS.pii_leak?.minScore).toBe(0.5);
  });

  it('sets a threshold only where the contract declares one, and within its bounds', () => {
    for (const policy of CONTRACT.policies) {
      const seeded = CHECKS[policy.id]!;
      const extras = Object.keys(seeded).filter((key) => !NON_THRESHOLD_FIELDS.has(key));
      if (!policy.threshold) {
        expect(extras).toEqual([]);
        continue;
      }
      expect(extras).toEqual([policy.threshold.field]);
      const value = (seeded as Record<string, unknown>)[policy.threshold.field] as number;
      expect(value).toBeGreaterThanOrEqual(policy.threshold.minimum);
      expect(value).toBeLessThanOrEqual(policy.threshold.maximum);
    }
  });

  it('owns a stable SYSTEM-tenant id so a re-seed and an operator find the same row', () => {
    expect(PLATFORM_GUARDRAIL_AVAILABILITY_ID).toBe('00000000-0000-0000-0018-000000000001');
    expect(SYSTEM_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
  });
});
