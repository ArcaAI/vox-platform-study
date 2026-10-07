/**
 * TASK-1050 W2h — the platform settings this lane governs:
 *   - `guardrail.hold.timeoutSeconds` (README §9.8.1): how long a blocked node waits for a resolution before the
 *     run ends `GUARDRAIL_BLOCKED` (resumable later by supersede). Default 24 h. Read by the gateway and
 *     injected on every harness run start (gateway-resolved injection, rule 06).
 *   - `guardrail.evaluations.reconcileGraceMinutes` / `.reconcileLookbackHours` (README §9.8.2): the
 *     evaluation-gap reconciler's window — thresholds are configuration, never literals.
 *   - `nlp.ner.resultCacheTtlSeconds` (600) / `nlp.ner.resultCacheMaxEntries` (1024) (TASK-1049 F10): the
 *     tenant-keyed NER result cache, served to apps/nlp on the pull route. `0` disables it.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY,
  GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY,
  GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY,
  GUARDRAIL_JUDGE_DEFAULTS,
} from '../descriptors/guardrail-judge.descriptors';

const descriptor = (key: string) => HOPE_SETTINGS_REGISTRY.getOrThrow(key);

describe('guardrail.hold.timeoutSeconds', () => {
  it('is a platform-only, open-to-default number, default 24 h', () => {
    expect(GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY).toBe('guardrail.hold.timeoutSeconds');
    expect(descriptor(GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY)).toMatchObject({
      tier: 'global-kv',
      dataType: 'number',
      maxScope: 'system',
      globalOnly: true,
      failMode: 'open-to-default',
      category: 'Guardrail Policy',
      default: 86_400,
    });
    expect(GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]).toBe(86_400);
  });

  it('is not a kill-switch', () => {
    expect(descriptor(GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY).killSwitch).toBeFalsy();
  });

  it.each([
    [60, true],
    [86_400, true],
    [7 * 86_400, true],
    [59, false],
    [7 * 86_400 + 1, false],
    [90.5, false],
    ['3600', false],
  ])('validate(%j) accepted=%s', (value, ok) => {
    const result = descriptor(GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY).validate?.(value);
    if (ok) expect(result).toBeUndefined();
    else expect(result).toBeDefined();
  });
});

describe('the evaluation reconciler window', () => {
  it.each([
    [GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY, 10, 1, 1440],
    [GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY, 24, 1, 168],
  ])('%s: platform-only, default %s, bounded [%s, %s]', (key, value, min, max) => {
    const d = descriptor(key);
    expect(d).toMatchObject({ tier: 'global-kv', maxScope: 'system', globalOnly: true, failMode: 'open-to-default', default: value });
    expect(d.validate?.(min)).toBeUndefined();
    expect(d.validate?.(max)).toBeUndefined();
    expect(d.validate?.(min - 1)).toBeDefined();
    expect(d.validate?.(max + 1)).toBeDefined();
  });
});

describe('nlp NER result cache (TASK-1049 F10)', () => {
  it.each([
    ['nlp.ner.resultCacheTtlSeconds', 600],
    ['nlp.ner.resultCacheMaxEntries', 1024],
  ])('%s: served to nlp, open-to-default, default %s', (key, value) => {
    expect(descriptor(key)).toMatchObject({
      tier: 'global-kv',
      dataType: 'number',
      consumedBy: ['nlp'],
      maxScope: 'system',
      globalOnly: true,
      failMode: 'open-to-default',
      category: 'Service Runtime',
      default: value,
    });
    expect(descriptor(key).label.length).toBeGreaterThan(0);
    expect(descriptor(key).description).toContain('0');
  });
});
