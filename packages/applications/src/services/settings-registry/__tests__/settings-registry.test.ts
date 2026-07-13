import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import type { SettingDescriptor } from '../registry.types';

// TASK-504 Phase 3a — the capability/settings registry: one typed catalog that
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
    // harnessEnabled is the rollout knob — capped at DEPARTMENT, fail-closed default
    const harness = HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.harnessEnabled');
    expect(harness).toMatchObject({ maxScope: 'department', default: false });
    // the clamp must reject setting the rollout knob per-doctor
    expect(() => HOPE_SETTINGS_REGISTRY.assertWithinMaxScope('pipeline.harnessEnabled', 'doctor')).toThrow(ArgumentInvalidException);
  });

  it('registers the TTS BYO provider credentials as db-secret / secret sensitivity', () => {
    const azure = HOPE_SETTINGS_REGISTRY.getOrThrow('tts.credential.azure');
    expect(azure).toMatchObject({ tier: 'db-secret', dataType: 'secret', sensitivity: 'secret', maxScope: 'tenant' });
    expect(HOPE_SETTINGS_REGISTRY.has('tts.credential.sarvam')).toBe(true);
  });

  it('registers the entitlements kill-switch as a global-only flag', () => {
    const ks = HOPE_SETTINGS_REGISTRY.getOrThrow('entitlements.enabled');
    expect(ks.globalOnly).toBe(true);
    expect(ks.maxScope).toBe('system');
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
