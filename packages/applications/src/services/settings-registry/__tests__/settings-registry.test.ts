import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import type { SettingDescriptor } from '../registry.types';
import { AI_TASK_MODEL_TASK_TYPES } from '../../ai-task-default/constants';
import { ModelTaskType } from '@arcaai/domains';

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

  // The two pipeline toggles that gate guardrail's primary caller (the
  // harness) and NLP auto-extraction are global-admin-only. Enforcement reads
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

  // Task-model default descriptors (models.<taskKey>).
  it('registers the AI task-model defaults as db-config strings, maxScope tenant', () => {
    for (const key of [
      'models.guardrail.validate',
      'models.guardrail.safety',
      'models.guardrail.groundedness',
      'models.nlp.ner',
      'models.nlp.classification',
      'models.nlp.diagnosis',
      'models.smr.live',
      'models.smr.finalize',
      'models.smr.live.fallback',
      'models.smr.finalize.fallback',
      'models.harness.judge',
    ]) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key)).toMatchObject({
        tier: 'db-config',
        dataType: 'string',
        sensitivity: 'internal',
        maxScope: 'tenant',
      });
    }
  });

  // The two per-tenant SMR fallback keys are TEXT_GENERATION.
  it('maps the smr fallback task keys to TEXT_GENERATION model task types', () => {
    expect(AI_TASK_MODEL_TASK_TYPES['smr.live.fallback']).toBe(ModelTaskType.TEXT_GENERATION);
    expect(AI_TASK_MODEL_TASK_TYPES['smr.finalize.fallback']).toBe(ModelTaskType.TEXT_GENERATION);
  });

  it('flags guardrail.*/nlp.*/harness.* task-model defaults as global-admin-only (editableBy all, globalOnly)', () => {
    // These task-model defaults are platform-owned: guardrail (owner directive),
    // nlp (revoked tenant writes), and harness.judge. All resolve to the
    // global-admin resource and carry globalOnly. SMR is NOT in this set —
    // its selection is tenant-configurable.
    for (const key of [
      'models.guardrail.validate',
      'models.guardrail.safety',
      'models.guardrail.groundedness',
      'models.nlp.ner',
      'models.nlp.classification',
      'models.nlp.diagnosis',
      'models.harness.judge',
    ]) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.editableBy, key).toBe('all');
      expect(d.globalOnly, key).toBe(true);
    }
  });

  // SMR summarization model selection (primary + per-tenant fallback)
  // is tenant-admin configurable: the descriptors resolve to the tenant-editable
  // AiTaskDefault resource and are NOT flagged globalOnly.
  it('flags smr.* task-model defaults (primary + fallback) as tenant-editable (editableBy AiTaskDefault, not globalOnly)', () => {
    for (const key of ['models.smr.live', 'models.smr.finalize', 'models.smr.live.fallback', 'models.smr.finalize.fallback']) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.editableBy, key).toBe('AiTaskDefault');
      expect(d.globalOnly, key).toBeUndefined();
    }
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
