/**
 * TASK-879 — the eighteen `tts.*` keys are GONE from the registry, not dual-homed.
 *
 * The program's rule (TASK-870 §Wave 3) is that a moved key is removed COMPLETELY — descriptor,
 * reader, `Settings` field, env path, seed — because two control surfaces for one fact is how
 * they come to disagree. This file is the registry half of that assertion; the Python half is
 * `apps/tts/src/tts/tests/unit/test_task799_control_plane.py`, which pins that nothing in
 * `apps/tts` still reads them.
 *
 * The table below is the record of WHERE each one went, so a reader who finds a stale reference
 * has somewhere to look rather than a bare absence.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

/** key → the row that owns the fact now. */
const MOVED: Record<string, string> = {
  // → the AGENT the AgentAssignment cascade selects
  'tts.defaultVoiceEn': 'Agent.parameters.voice',
  'tts.limits.sampleRate': 'Agent.parameters.sampleRate',
  // → the AiModel row the agent binds
  'tts.sarvam.model': 'AiModel(sarvam-bulbul).sourceUri',
  'tts.indicParler.hfModel': 'AiModel(indic-parler-tts).sourceUri',
  'tts.indicParler.modelPath': 'AiModel(indic-parler-tts).localPath',
  'tts.indicF5.hfModel': 'AiModel(indic-f5).sourceUri',
  'tts.indicF5.modelPath': 'AiModel(indic-f5).localPath',
  // → AiModel._metadata
  'tts.indicParler.descEncoderPath': 'AiModel(indic-parler-tts)._metadata.artifacts.descEncoderPath',
  'tts.indicF5.refAudioPath': 'AiModel(indic-f5)._metadata.voices[].refAudioPath',
  'tts.indicF5.refText': 'AiModel(indic-f5)._metadata.voices[].refText',
  // → the AiProviderConnection row that serves the engine
  'tts.azure.region': 'AiProviderConnection(tts, azure).region',
  'tts.sarvam.baseUrl': 'AiProviderConnection(tts, sarvam).baseUrl',
  'tts.sarvam.timeoutS': 'AiProviderConnection(tts, sarvam).timeoutS',
  'tts.azure.enabled': 'AiProviderConnection(tts, azure).enabled',
  'tts.sarvam.enabled': 'AiProviderConnection(tts, sarvam).enabled',
  'tts.kokoro.enabled': 'AiProviderConnection(tts, kokoro).enabled',
  'tts.parler.enabled': 'AiProviderConnection(tts, indic_parler).enabled',
  'tts.indicf5.enabled': 'AiProviderConnection(tts, indic_f5).enabled',
};

/** What a `tts.*` key may still legitimately be. */
const KEPT = ['tts.indicParler.device', 'tts.indicF5.device', 'tts.limits.maxInputChars', 'tts.warmupEnabled', 'tts.modelCache.ttlSeconds', 'tts.serviceToken'];

describe('TASK-879 — the tts.* registry surface after the move', () => {
  it.each(Object.entries(MOVED))('%s is absent (now: %s)', (key) => {
    expect(HOPE_SETTINGS_REGISTRY.get(key), `${key} must be removed, not dual-homed — it now lives at ${MOVED[key]}`).toBeUndefined();
  });

  it('leaves exactly the process-level knobs, the model-cache TTL and the service token', () => {
    const remaining = HOPE_SETTINGS_REGISTRY.list()
      .map((descriptor) => descriptor.key)
      .filter((key) => key.startsWith('tts.'))
      .sort();
    expect(remaining).toEqual([...KEPT].sort());
  });

  it('lands the program`s registry target for this lane: 277 − 18 = 259', () => {
    expect(HOPE_SETTINGS_REGISTRY.list()).toHaveLength(259);
  });
});
