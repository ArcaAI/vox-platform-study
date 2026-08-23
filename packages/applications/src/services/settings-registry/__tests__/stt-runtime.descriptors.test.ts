// Governance for the stt runtime knobs migrated off env by TASK-799 lane C.
//
// These assertions are about the SHAPE of the migration, not about individual
// values — the value-level parity check (descriptor default === the Python
// field default) lives on the Python side, in
// `apps/stt/tests/unit/test_task799_descriptor_parity.py`, because that is the
// side that can read the authoritative defaults without transcribing them.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { STT_RUNTIME_SETTINGS } from '../descriptors/stt-runtime.descriptors';
import { SERVICE_RUNTIME_DEFAULTS } from '../descriptors/service-runtime.descriptors';

describe('STT_RUNTIME_SETTINGS', () => {
  it('registers every descriptor in the assembled registry', () => {
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(HOPE_SETTINGS_REGISTRY.get(descriptor.key), descriptor.key).toBeDefined();
    }
  });

  it('does not collide with the capacity knobs in SERVICE_RUNTIME_DEFAULTS', () => {
    // The registry throws on a duplicate key, so a collision would fail at
    // module load. This states the intent explicitly: stt's four capacity knobs
    // stay in the generated `<service>.modelCache.*` family and are NOT
    // re-declared here.
    const existing = new Set(Object.keys(SERVICE_RUNTIME_DEFAULTS));
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(existing.has(descriptor.key), descriptor.key).toBe(false);
    }
  });

  it('puts every key on the stt pull route and nothing else', () => {
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(descriptor.key.startsWith('stt.'), descriptor.key).toBe(true);
      expect(descriptor.consumedBy, descriptor.key).toEqual(['stt']);
    }
  });

  it('is PLATFORM scope throughout — D-1 keeps the pull route one entry per process', () => {
    // A `maxScope: 'tenant'` descriptor must never declare `consumedBy`: the
    // pull route is a single cached snapshot per service process, so a
    // tenant-varying key on it would turn one cache entry into one per customer.
    // Anything tenant-varying travels the PUSH channel instead.
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(descriptor.maxScope, descriptor.key).toBe('system');
      expect(descriptor.globalOnly, descriptor.key).toBe(true);
    }
  });

  it('carries no secret, so nothing here can be filtered off the wire unexpectedly', () => {
    // The read service drops `sensitivity: 'secret'` unconditionally. A
    // credential declared here would therefore resolve to null forever — a knob
    // that silently never arrives. Credentials belong in `platform-secrets` /
    // `AiProviderConnection`, and every cloud engine stt talks to is BYOK.
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(descriptor.sensitivity, descriptor.key).toBe('internal');
      expect(descriptor.dataType, descriptor.key).not.toBe('secret');
    }
  });

  it('is tuning, so a control-plane miss degrades instead of failing the pull', () => {
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(descriptor.failMode, descriptor.key).toBe('open-to-default');
    }
  });

  it('declares a default for every key — that is what makes the migration behaviour-neutral', () => {
    // With no `GlobalSetting` row the cascade resolves `descriptor.default`, so
    // an unseeded deployment runs on exactly the values it ran on before. A
    // descriptor with no default would instead resolve to `undefined`, fail the
    // dataType check, and log a warning on every pull.
    for (const descriptor of STT_RUNTIME_SETTINGS) {
      expect(descriptor.default, descriptor.key).toBeDefined();
      expect(typeof descriptor.default, descriptor.key).toBe(
        descriptor.dataType === 'boolean' ? 'boolean' : descriptor.dataType === 'number' ? 'number' : 'string',
      );
    }
  });

  it('keeps every kill-switch defaulting OFF', () => {
    // `SettingsRegistry.killSwitches()` asserts this globally; repeating it here
    // names the two that are marked, and documents why `stt.pubsub.enabled` —
    // which defaults ON — is deliberately NOT marked as one.
    const killSwitches = STT_RUNTIME_SETTINGS.filter((d) => d.killSwitch);
    expect(killSwitches.map((d) => d.key).sort()).toEqual([
      'stt.azureFoundry.enabled',
      'stt.punctuation.enabled',
      'stt.semanticEndpoint.enabled',
    ]);
    for (const descriptor of killSwitches) {
      expect(descriptor.default, descriptor.key).toBe(false);
    }

    const pubsub = STT_RUNTIME_SETTINGS.find((d) => d.key === 'stt.pubsub.enabled');
    expect(pubsub?.killSwitch).toBeUndefined();
    expect(pubsub?.default).toBe(true);
  });

  it('does not claim the db-config storage keys', () => {
    // `STORAGE_PROVIDER` / `AZURE_STORAGE_*` belong in the
    // `storage.platformDefault.*` cascade, which is `tier: 'db-config'` — a tier
    // `EffectiveSettingsService.resolveEffective` has no resolver for. Declaring
    // `consumedBy` on those would deploy cleanly and do nothing at all.
    const storage = HOPE_SETTINGS_REGISTRY.get('storage.platformDefault.provider');
    expect(storage?.tier).toBe('db-config');
    expect(storage?.consumedBy).toBeUndefined();
  });
});
