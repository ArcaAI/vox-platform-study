// Batch-transcription limit descriptors.
//
// The four knobs that make "up to 5 recordings, each at most 60 minutes"
// admin-controllable instead of hardcoded. They are platform CAPACITY knobs, so
// they are `global-kv` + `globalOnly` + `maxScope: 'system'` (a tenant may not
// raise its own ceiling), and every one is `open-to-default`: a missing row must
// degrade to the code default here, never to an outage on the upload path.

import { describe, expect, it } from 'vitest';
import { BATCH_TRANSCRIPTION_DEFAULTS, BATCH_TRANSCRIPTION_SETTINGS, BatchTranscriptionKnobKey } from '../descriptors/batch-transcription.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const KEYS: BatchTranscriptionKnobKey[] = ['maxFilesPerBatch', 'maxDurationMinutes', 'maxFileSizeMb', 'maxActiveJobsPerUser'];

describe('batch-transcription limit descriptors', () => {
  it('registers every knob under the `stt.batch.` namespace', () => {
    for (const knob of KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.get(`stt.batch.${knob}`), knob).toBeDefined();
    }
  });

  it('carries the product requirement as its code defaults', () => {
    // These two ARE the requirement — 5 recordings, 60 minutes each.
    expect(BATCH_TRANSCRIPTION_DEFAULTS.maxFilesPerBatch).toBe(5);
    expect(BATCH_TRANSCRIPTION_DEFAULTS.maxDurationMinutes).toBe(60);
    // Raised from the hardcoded 100 MB so a 60-minute 16 kHz mono WAV (~115 MB)
    // is bounded by the DURATION ceiling rather than rejected on size first.
    expect(BATCH_TRANSCRIPTION_DEFAULTS.maxFileSizeMb).toBe(250);
    expect(BATCH_TRANSCRIPTION_DEFAULTS.maxActiveJobsPerUser).toBe(5);
  });

  it('declares the descriptor default identically to the code default', () => {
    for (const knob of KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(`stt.batch.${knob}`).default, knob).toBe(BATCH_TRANSCRIPTION_DEFAULTS[knob]);
    }
  });

  it('is a platform capacity knob: global-kv, super-admin only, never tenant-set', () => {
    for (const knob of KEYS) {
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(`stt.batch.${knob}`);
      expect(descriptor.tier, knob).toBe('global-kv');
      expect(descriptor.globalOnly, knob).toBe(true);
      expect(descriptor.maxScope, knob).toBe('system');
      expect(descriptor.dataType, knob).toBe('number');
      expect(descriptor.sensitivity, knob).toBe('internal');
    }
  });

  it('fails OPEN to the code default — a missing row must not break uploads', () => {
    for (const knob of KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(`stt.batch.${knob}`).failMode, knob).toBe('open-to-default');
    }
  });

  it('is not a kill-switch (nothing here gates enforcement on/off)', () => {
    for (const descriptor of BATCH_TRANSCRIPTION_SETTINGS) {
      expect(descriptor.killSwitch, descriptor.key).toBeUndefined();
    }
  });
});
