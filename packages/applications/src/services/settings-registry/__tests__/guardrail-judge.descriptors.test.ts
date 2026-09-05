// TASK-878 — the delegated judgement's per-call budget, as a governed key.
//
// It was `JudgePolicy.timeout_s = 60.0` in guardrail's `core/config.py`. The
// contract this file pins is the one that distinguishes a governed key from the
// decorative kind TASK-872 deleted: it is registered, it is RESOLVABLE on the
// pull route, its default is today's literal (so registering it changed nothing),
// and it is platform-scope because guardrail is platform-only.

import { describe, expect, it } from 'vitest';
import { effectiveResolverLane } from '../effective-settings.service';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { GUARDRAIL_JUDGE_DEFAULTS, GUARDRAIL_JUDGE_SETTINGS, GUARDRAIL_JUDGE_TIMEOUT_KEY } from '../descriptors/guardrail-judge.descriptors';

describe('guardrail.judge.timeoutSeconds', () => {
  const descriptor = () => HOPE_SETTINGS_REGISTRY.getOrThrow(GUARDRAIL_JUDGE_TIMEOUT_KEY);

  it('is registered in the assembled catalog', () => {
    expect(GUARDRAIL_JUDGE_SETTINGS.map((d) => d.key)).toEqual([GUARDRAIL_JUDGE_TIMEOUT_KEY]);
    expect(descriptor()).toBeDefined();
  });

  it('lives in the global-kv tier at platform scope — guardrail is platform-only', () => {
    // TASK-870 owner decision item 5: no tenant admin manages any guardrail
    // setting. `maxScope: 'system'` + `globalOnly` say that declaratively, so the
    // uniform clamp and the write lane enforce it without a per-key check.
    const d = descriptor();
    expect(d.tier).toBe('global-kv');
    expect(d.dataType).toBe('number');
    expect(d.maxScope).toBe('system');
    expect(d.globalOnly).toBe(true);
    expect(d.sensitivity).toBe('internal');
    expect(d.category).toBe('Guardrail Policy');
  });

  it('is served to apps/guardrail over the pull route, and actually resolves there', () => {
    // `consumedBy` alone is not enough: a key whose tier has no resolver lane
    // serves `null` forever with one WARN line to show for it.
    const d = descriptor();
    expect(d.consumedBy).toEqual(['guardrail']);
    expect(effectiveResolverLane(d)).not.toBeNull();
  });

  it('is open-to-default at the literal it replaced — registering it changed no behaviour', () => {
    // The Python mirror is `core/effective_config.DEFAULT_JUDGE_TIMEOUT_S`, and
    // `apps/guardrail/src/guardrail/tests/test_task878_outbound_judge.py` pins
    // that side to the same 60. Fail-closed would be wrong: a control-plane
    // outage must not turn every clinical judgement into a failure.
    const d = descriptor();
    expect(d.failMode).toBe('open-to-default');
    expect(d.default).toBe(60);
    expect(GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY]).toBe(60);
  });

  it('is not a kill-switch and carries no tighten-only floor', () => {
    // Neither concept applies: it gates no enforcement, and there is no tenant
    // tier that could loosen it.
    const d = descriptor();
    expect(d.killSwitch).toBeFalsy();
    expect(d.floorDirection).toBeUndefined();
  });

  it('is the only guardrail.judge.* key — the two hyperparameters are NOT here', () => {
    // They are model-coupled, so they live on `AiModel._metadata.policy`
    // (`judgeTemperature` / `judgeMaxTokens`, fail-closed) and resolve through
    // the cascade that chose the model. Registering them here would recreate
    // exactly the split TASK-872 removed: a knob in the catalog that the value's
    // real source ignores.
    const judgeKeys = HOPE_SETTINGS_REGISTRY.list()
      .map((d) => d.key)
      .filter((k) => k.startsWith('guardrail.judge.'));
    expect(judgeKeys).toEqual([GUARDRAIL_JUDGE_TIMEOUT_KEY]);
    expect(HOPE_SETTINGS_REGISTRY.get('guardrail.judge.temperature')).toBeUndefined();
    expect(HOPE_SETTINGS_REGISTRY.get('guardrail.judge.maxTokens')).toBeUndefined();
  });
});
