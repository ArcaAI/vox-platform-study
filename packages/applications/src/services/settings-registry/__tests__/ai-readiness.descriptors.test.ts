// TASK-890 L12 — the five `global-kv` keys behind inference readiness.
//
// Three are new (`inference.readiness.*`); two have been READ by
// `ModelInventoryCronService` since TASK-860 with NO descriptor registering
// them, which is exactly the ungoverned-surface shape rule 09 §Configuration
// Tiers forbids: the sweep's posture was a code constant no admin could reach.
// Registering a descriptor is the ONLY step needed to make a key governed, so
// these tests pin BOTH halves — the descriptor policy, and that the consuming
// cron's own fallbacks agree with the descriptor defaults (two defaults for one
// key is a divergence nothing else would catch).

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  AI_READINESS_SETTINGS,
  INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
  INFERENCE_READINESS_ENABLED_KEY,
  INFERENCE_READINESS_INTERVAL_KEY,
} from '../descriptors/ai-readiness.descriptors';
import { INFERENCE_READINESS_DEFAULTS } from '../../ai-readiness/inference-readiness.constants';
import { MODEL_INVENTORY_SETTING_KEYS, ModelInventoryCronService } from '../../ai-model/inventory/model-inventory.cron.service';

const KEYS = [
  INFERENCE_READINESS_ENABLED_KEY,
  INFERENCE_READINESS_INTERVAL_KEY,
  INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
  MODEL_INVENTORY_SETTING_KEYS.enabled,
  MODEL_INVENTORY_SETTING_KEYS.cron,
];

describe('ai-readiness descriptors — registration and policy', () => {
  it('registers all five keys in the assembled registry', () => {
    for (const key of KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.get(key), `${key} is not registered`).toBeDefined();
    }
    expect(AI_READINESS_SETTINGS.map((d) => d.key).sort()).toEqual([...KEYS].sort());
  });

  it('classifies every key as a platform `global-kv` knob — never env, never a tenant surface', () => {
    for (const key of KEYS) {
      const descriptor = HOPE_SETTINGS_REGISTRY.get(key)!;
      expect(descriptor.tier, key).toBe('global-kv');
      expect(descriptor.targetTier, key).toBeUndefined();
      expect(descriptor.maxScope, key).toBe('system');
      expect(descriptor.globalOnly, key).toBe(true);
      expect(descriptor.sensitivity, key).toBe('internal');
      // Tuning knobs and measurement switches degrade to their default; nothing
      // here is a provider/model SELECTION, so nothing here is fail-closed.
      expect(descriptor.failMode, key).toBe('open-to-default');
      // Not served on the effective-config pull route: readiness is resolved
      // inside the gateway and no Python service reads these.
      expect(descriptor.consumedBy, key).toBeUndefined();
      expect(descriptor.label, key).toBeTruthy();
      expect(descriptor.description, key).toBeTruthy();
    }
  });

  it('carries the deployed-posture defaults (pre-production ships ENABLED)', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(INFERENCE_READINESS_ENABLED_KEY)!.default).toBe(true);
    expect(HOPE_SETTINGS_REGISTRY.get(INFERENCE_READINESS_INTERVAL_KEY)!.default).toBe(INFERENCE_READINESS_DEFAULTS.intervalSeconds);
    expect(HOPE_SETTINGS_REGISTRY.get(INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY)!.default).toBe(
      INFERENCE_READINESS_DEFAULTS.cloudProbeIntervalSeconds,
    );
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_INVENTORY_SETTING_KEYS.enabled)!.default).toBe(true);
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_INVENTORY_SETTING_KEYS.cron)!.default).toBe('0 * * * *');
  });

  it('declares no kill-switch — these are measurement switches, not enforcement gates', () => {
    // A `killSwitch` descriptor MUST default OFF (the registry enforces it at
    // assembly). Turning readiness or inventory off removes a MEASUREMENT, the
    // same polarity as `metering.outbox.drain.enabled`, so neither is one.
    for (const key of KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)!.killSwitch, key).toBeUndefined();
    }
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });
});

describe('ai-readiness descriptors — parity with the consuming code', () => {
  it('the inventory cron resolves the SAME defaults the descriptors declare', () => {
    // With no stored row, `getValueWithDefault` returns the call-site default —
    // so this asserts the cron's own constants, which is the half a descriptor
    // cannot see. Two disagreeing defaults for one key is invisible at runtime.
    const appSettings = { getValueWithDefault: <T>(_key: string, fallback: T): T => fallback };
    const cron = new ModelInventoryCronService(appSettings as never, { getCronJob: () => undefined } as never, {} as never);

    expect(cron.getConfig()).toEqual({
      enabled: HOPE_SETTINGS_REGISTRY.get(MODEL_INVENTORY_SETTING_KEYS.enabled)!.default,
      cron: HOPE_SETTINGS_REGISTRY.get(MODEL_INVENTORY_SETTING_KEYS.cron)!.default,
    });
  });
});
