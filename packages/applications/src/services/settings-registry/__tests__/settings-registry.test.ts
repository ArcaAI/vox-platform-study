import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import type { SettingDescriptor } from '../registry.types';

// The capability/settings registry: one typed catalog that
// classifies every admin-controllable variable (tier / scope / sensitivity /
// editor). This increment builds the container + descriptors; the resolver
// generalization and the catalog endpoint are later sub-phases.

function desc(over: Partial<SettingDescriptor> = {}): SettingDescriptor {
  return {
    key: 'test.flag',
    tier: 'db-config',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TestSubject',
    category: 'Test',
    ...over,
  };
}

describe('SettingsRegistry container', () => {
  it('registers and retrieves a descriptor', () => {
    const r = new SettingsRegistry().register(desc());
    expect(r.has('test.flag')).toBe(true);
    expect(r.get('test.flag')?.tier).toBe('db-config');
    expect(r.size).toBe(1);
  });

  it('rejects a duplicate key', () => {
    const r = new SettingsRegistry().register(desc());
    expect(() => r.register(desc())).toThrow(/duplicate/i);
  });

  it('get returns undefined for an unknown key; getOrThrow throws', () => {
    const r = new SettingsRegistry();
    expect(r.get('nope')).toBeUndefined();
    expect(() => r.getOrThrow('nope')).toThrow(/unknown setting/i);
  });

  it('lists every registered descriptor', () => {
    const r = new SettingsRegistry().registerAll([desc({ key: 'a' }), desc({ key: 'b' })]);
    expect(
      r
        .list()
        .map((d) => d.key)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('maps keys to their server-side category', () => {
    const r = new SettingsRegistry().registerAll([desc({ key: 'a', category: 'Pipeline' }), desc({ key: 'b', category: 'Credentials' })]);
    expect(r.categoriesOf(['a', 'b'])).toEqual({ a: 'Pipeline', b: 'Credentials' });
  });
});

describe('SettingsRegistry.assertWithinMaxScope (the uniform clamp)', () => {
  const r = new SettingsRegistry().registerAll([
    desc({ key: 'deep', maxScope: 'doctor' }),
    desc({ key: 'capped', maxScope: 'department' }),
    desc({ key: 'tenantOnly', maxScope: 'tenant' }),
  ]);

  it('allows a scope at or above the max', () => {
    expect(() => r.assertWithinMaxScope('deep', 'doctor')).not.toThrow();
    expect(() => r.assertWithinMaxScope('capped', 'department')).not.toThrow();
    expect(() => r.assertWithinMaxScope('capped', 'tenant')).not.toThrow();
    expect(() => r.assertWithinMaxScope('capped', 'system')).not.toThrow();
  });

  it('rejects a scope DEEPER than the max (ArgumentInvalidException → 400)', () => {
    expect(() => r.assertWithinMaxScope('capped', 'doctor')).toThrow(ArgumentInvalidException);
    expect(() => r.assertWithinMaxScope('tenantOnly', 'department')).toThrow(ArgumentInvalidException);
  });

  it('throws for an unknown key', () => {
    expect(() => r.assertWithinMaxScope('nope', 'tenant')).toThrow(/unknown setting/i);
  });
});

describe('HOPE_SETTINGS_REGISTRY (assembled catalog)', () => {
  it('registers the four pipeline toggles sourced from PIPELINE_SETTING_DESCRIPTORS', () => {
    const auto = HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.autoSummaryEnabled');
    expect(auto).toMatchObject({ tier: 'db-config', dataType: 'boolean', maxScope: 'doctor', default: true });
    // harnessEnabled is the rollout knob — capped at DEPARTMENT.
    // flipped its default to true (the legacy signable generator it used to
    // fall back to no longer exists).
    const harness = HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.harnessEnabled');
    expect(harness).toMatchObject({ maxScope: 'department', default: true });
    // the clamp must reject setting the rollout knob per-doctor
    expect(() => HOPE_SETTINGS_REGISTRY.assertWithinMaxScope('pipeline.harnessEnabled', 'doctor')).toThrow(ArgumentInvalidException);
  });

  // Was: "registers the TTS BYO provider credentials as db-secret / secret
  // sensitivity" over `tts.credential.{azure,sarvam}`. TASK-872 removed those
  // five `db-secret` descriptors (the three `stt.credential.*` twins with
  // them), leaving the tier with no members at all — so the assertion is now
  // the ABSENCE, which is the part that can regress. A `db-secret` descriptor
  // is unreachable by construction: `EffectiveSettingsService` refuses any
  // `sensitivity: 'secret'` read, and the write lane refuses the tier, so
  // registering one describes a control surface the registry does not have.
  // The per-tenant credentials themselves are unaffected — `TenantTtsConfig` /
  // `TenantSttConfig` own their storage (Vault-Transit columns) and their
  // write paths (their own DTOs).
  it('registers NO db-secret descriptor — the tier has no read or write lane', () => {
    const dbSecrets = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.tier === 'db-secret');
    expect(dbSecrets.map((d) => d.key)).toEqual([]);
    for (const key of ['tts.credential.azure', 'tts.credential.sarvam', 'stt.credential.azure-speech', 'stt.credential.sarvam', 'stt.credential.openai']) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(false);
    }
  });

  // The two pipeline toggles that gate guardrail's primary caller (the
  // harness) and NLP auto-extraction are super-admin-only. Enforcement reads
  // THIS metadata, so the descriptor is the contract, not a hand-rolled key
  // list in the service.
  it('flags pipeline.harnessEnabled + pipeline.autoNerEnabled as globalOnly, leaving the other two tenant-writable', () => {
    for (const key of ['pipeline.harnessEnabled', 'pipeline.autoNerEnabled']) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).globalOnly, key).toBe(true);
    }
    for (const key of ['pipeline.autoSummaryEnabled', 'pipeline.dnaStyleEnabled']) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).globalOnly ?? false, key).toBe(false);
    }
  });

  it('leaves the pipeline maxScope cascade untouched by the globalOnly lock', () => {
    // Only WHO may write changed — the cascade shape must not drift.
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.harnessEnabled').maxScope).toBe('department');
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.autoNerEnabled').maxScope).toBe('doctor');
  });

  // The nightly SYSTEM-template resync sweep. Registering
  // these makes the sweep discoverable and writable through the admin settings
  // surface instead of being an unmanageable pair of magic strings read straight
  // out of AppSettings.
  it('registers the pipeline template-resync sweep controls', () => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.templateResync.enabled')).toMatchObject({
      tier: 'global-kv',
      dataType: 'boolean',
      maxScope: 'system',
      globalOnly: true,
      killSwitch: true,
      // Governance: a kill-switch defaults OFF. The sweep is turned ON by a
      // seeded platform VALUE, not by flipping this fail-safe default.
      default: false,
    });
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.templateResync.cron')).toMatchObject({
      tier: 'global-kv',
      dataType: 'string',
      maxScope: 'system',
      globalOnly: true,
      default: '0 3 * * *',
    });
  });

  it('registers the entitlements kill-switch as a global-only flag', () => {
    const ks = HOPE_SETTINGS_REGISTRY.getOrThrow('entitlements.enabled');
    expect(ks.globalOnly).toBe(true);
    expect(ks.maxScope).toBe('system');
  });

  // TASK-881 — the `models.<taskKey>` descriptors are GONE with the
  // `AiTaskDefault` facade. Model selection is not a setting; it resolves
  // through `AiRoutingPolicyService.resolveDefault` (SYSTEM row, super-admin
  // only for `guardrail.*` / `nlp.*` / `harness.*`). Pinned in
  // `ai-routing-policy/__tests__/task-key-vocabulary.test.ts`.
  it('registers no models.* descriptor', () => {
    expect(HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('models.'))).toEqual([]);
  });

  it('every descriptor carries the required classification fields', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      expect(d.key).toBeTruthy();
      expect(d.tier).toBeTruthy();
      expect(d.dataType).toBeTruthy();
      expect(d.sensitivity).toBeTruthy();
      expect(d.maxScope).toBeTruthy();
      expect(d.editableBy).toBeTruthy();
      expect(d.category).toBeTruthy();
    }
  });

  it('has no duplicate keys (assembly succeeded)', () => {
    const keys = HOPE_SETTINGS_REGISTRY.list().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('SettingsRegistry.killSwitches (governance)', () => {
  it('lists the entitlements enforcement kill-switch', () => {
    const keys = HOPE_SETTINGS_REGISTRY.killSwitches().map((d) => d.key);
    expect(keys).toContain('entitlements.enabled');
  });

  it('every kill-switch defaults OFF (fail-safe)', () => {
    for (const ks of HOPE_SETTINGS_REGISTRY.killSwitches()) {
      expect(ks.default).not.toBe(true);
    }
  });

  it('throws if a kill-switch is registered defaulting ON', () => {
    const r = new SettingsRegistry().register({
      key: 'bad.switch',
      tier: 'global-kv',
      dataType: 'boolean',
      sensitivity: 'internal',
      maxScope: 'system',
      editableBy: 'GlobalSetting',
      category: 'Test',
      killSwitch: true,
      default: true,
    });
    expect(() => r.killSwitches()).toThrow(/default OFF/i);
  });
});
