// Governance for the stt runtime knobs migrated off env by lane C.
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

  it('has no kill-switch left, and still refuses to mark the one flag that defaults ON', () => {
    // Three lived here. `stt.semanticEndpoint.enabled` and `stt.punctuation.enabled`
    // went in TASK-877, `stt.azureFoundry.enabled` in TASK-880 — and all three for the
    // same reason: a kill-switch is the wrong SHAPE for a decision that belongs to the
    // agent or to a connection row. The agent chooses `streaming.endpointing` and
    // `postProcessing.punctuation.enabled` and the platform vetoes by not publishing
    // the model row each needs; the Foundry preview veto is the SYSTEM
    // `AiProviderConnection(stt, azure-foundry)` row seeded disabled, which is also
    // decidable per tenant as a boolean never could be.
    expect(STT_RUNTIME_SETTINGS.filter((d) => d.killSwitch)).toEqual([]);

    // `stt.pubsub.enabled` defaults ON and is deliberately NOT marked: the registry
    // refuses a kill-switch that defaults ON, and flipping it OFF would take live
    // transcription off the air on first deploy. It is a data path, not a gate.
    const pubsub = STT_RUNTIME_SETTINGS.find((d) => d.key === 'stt.pubsub.enabled');
    expect(pubsub?.killSwitch).toBeUndefined();
    expect(pubsub?.default).toBe(true);
  });

  it('has no orphaned semanticEndpoint.enabled feature flag left behind', () => {
    // The EIGHTH duplicate of the `stt.semanticEndpoint.*` family lived outside
    // this file, in `feature-flags.descriptors.ts` — a bare (no `stt.` prefix)
    // `semanticEndpoint.enabled`, `tier: 'env'`, bound to `SEMANTIC_ENDPOINT_ENABLED`.
    // Its only reader was the `Settings.semantic_endpoint_enabled` field TASK-877
    // deleted with the rest of the family, so the descriptor was left with nothing
    // reading it. Deleted for the same reason as the other seven: a duplicate from
    // the old architecture is removed completely, not left dual-homed.
    expect(HOPE_SETTINGS_REGISTRY.has('semanticEndpoint.enabled')).toBe(false);
  });

  /**
   * TASK-880 — the twelve keys that moved to the agent, the model row or the provider
   * connection. Each is asserted ABSENT from the whole registry, not just from this file:
   * the owner's rule is that a redundant key from the old architecture is removed
   * COMPLETELY, and a re-declaration under any other descriptor file would be the
   * dual-homing this checks for.
   */
  const MOVED_AWAY_TASK_880: ReadonlyArray<[key: string, newHome: string]> = [
    ['stt.whisperCpp.consultationPromptEnabled', "the agent's instruction.initialPrompt"],
    ['stt.vad.modelPath', 'AiModel(VOICE_ACTIVITY_DETECTION).localPath, already on the spec'],
    ['stt.vad.speechPadMs', 'agent audioFrontEnd.vad.speechPadMs'],
    ['stt.transcription.chunkLengthS', 'agent decoding.chunkLengthSec'],
    ['stt.transcription.strideLengthS', 'agent decoding.strideLengthSec'],
    ['stt.whisperCpp.maxAudioSeconds', 'AiModel._metadata.asr.maxDecodeWindowSec'],
    ['stt.streaming.partialWindowS', 'AiModel._metadata.asr.partialWindowSec'],
    ['stt.azureSpeech.region', 'AiProviderConnection(stt, azure-speech).region'],
    ['stt.sarvam.baseUrl', 'AiProviderConnection(stt, sarvam).baseUrl'],
    ['stt.openai.baseUrl', 'AiProviderConnection(stt, openai).baseUrl'],
    ['stt.azureFoundry.endpoint', 'AiProviderConnection(stt, azure-foundry).baseUrl'],
    ['stt.azureFoundry.enabled', 'the AiProviderConnection(stt, azure-foundry) row state'],
  ];

  it.each(MOVED_AWAY_TASK_880)('%s is gone from the registry entirely (now: %s)', (key) => {
    expect(HOPE_SETTINGS_REGISTRY.has(key)).toBe(false);
    expect(STT_RUNTIME_SETTINGS.map((d) => d.key)).not.toContain(key);
  });

  it('leaves the storage keys to the db-config cascade rather than re-declaring them here', () => {
    // `STORAGE_PROVIDER` / `AZURE_STORAGE_*` belong in the
    // `storage.platformDefault.*` cascade — a `TenantStorageConfig` row, which
    // is what `db-config` is reserved for (D-2). This file must not grow an
    // `stt.storage.provider` twin of it; that is the second-home failure mode.
    expect(STT_RUNTIME_SETTINGS.map((d) => d.key).filter((k) => k.startsWith('stt.storage'))).toEqual([]);

    // A.1 inverted the assertion that used to live here. Until the
    // `db-config` read lane existed, declaring `consumedBy` on these keys
    // deployed cleanly and served `null` forever, so the test pinned
    // `consumedBy: undefined` to stop anyone shipping the dead declaration.
    // The lane exists now, so the honest invariant is the opposite one: stt
    // MUST be served the provider, because its `storage_provider` env path is
    // closed and this is the only surface left that can set it.
    const storage = HOPE_SETTINGS_REGISTRY.get('storage.platformDefault.provider');
    expect(storage?.tier).toBe('db-config');
    expect(storage?.consumedBy).toEqual(['stt']);
  });
});
