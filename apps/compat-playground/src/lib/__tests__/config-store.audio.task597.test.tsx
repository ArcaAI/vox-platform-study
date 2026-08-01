/**
 * Playground config store — the TASK-597 audio + drain settings.
 *
 * Two classes of value with deliberately different defaulting rules, and both
 * are easy to get wrong in the same way (`||` instead of `??`, truthiness
 * instead of a presence check):
 *
 *  - NOISE SUPPRESSION / VAD are booleans that must round-trip `false`
 *    faithfully. They are connection-level and always end up as a real boolean
 *    in `V1SdkConfig.audioSettings`, because "unset" there would silently mean
 *    "off" with no way back on.
 *  - DRAIN TIMEOUT / QUIET WINDOW are optional numbers where `undefined` means
 *    "use the SDK default" and `0` is a MEANINGFUL setting (disable the
 *    quiet-window early resolve). Those two must never collapse into each other.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { defaultConfig, saveStoredConfig, clearStoredConfig, type PlaygroundConfig } from '../config-store';

const BASE: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'k-1',
  tenantId: '',
  pipelineId: 'pipe-1',
  languageMode: 'ml-en',
};

describe('config-store — noise suppression / VAD round-trip (TASK-597)', () => {
  beforeEach(() => {
    clearStoredConfig();
  });

  it('defaults BOTH to false — the pre-597 effective behaviour, made explicit', () => {
    const cfg = defaultConfig();
    expect(cfg.noiseSuppression).toBe(false);
    expect(cfg.voiceActivityDetection).toBe(false);
  });

  it('round-trips true', () => {
    saveStoredConfig({ ...BASE, noiseSuppression: true, voiceActivityDetection: true });
    const cfg = defaultConfig();
    expect(cfg.noiseSuppression).toBe(true);
    expect(cfg.voiceActivityDetection).toBe(true);
  });

  it('round-trips an explicit false without re-defaulting it', () => {
    // A `||` fallback would produce the same answer here by accident, so the
    // true→false transition below is the one that actually discriminates.
    saveStoredConfig({ ...BASE, noiseSuppression: true, voiceActivityDetection: true });
    expect(defaultConfig().noiseSuppression).toBe(true);

    saveStoredConfig({ ...BASE, noiseSuppression: false, voiceActivityDetection: false });
    expect(defaultConfig().noiseSuppression).toBe(false);
    expect(defaultConfig().voiceActivityDetection).toBe(false);
  });

  it('round-trips the two switches INDEPENDENTLY', () => {
    saveStoredConfig({ ...BASE, noiseSuppression: false, voiceActivityDetection: true });
    const cfg = defaultConfig();
    expect(cfg.noiseSuppression).toBe(false);
    expect(cfg.voiceActivityDetection).toBe(true);
  });

  it('tolerates a config saved BEFORE these fields existed', () => {
    // Real localStorage payloads predate this change; they must not throw and
    // must land on the documented default rather than `undefined`.
    window.localStorage.setItem('hope-compat-playground:config', JSON.stringify(BASE));
    const cfg = defaultConfig();
    expect(cfg.noiseSuppression).toBe(false);
    expect(cfg.voiceActivityDetection).toBe(false);
  });
});

describe('config-store — stop-drain knobs (TASK-597)', () => {
  beforeEach(() => {
    clearStoredConfig();
  });

  it('leaves both UNDEFINED by default, so the SDK defaults apply', () => {
    const cfg = defaultConfig();
    expect(cfg.drainTimeoutMs).toBeUndefined();
    expect(cfg.quietWindowMs).toBeUndefined();
  });

  it('round-trips quietWindowMs: 0 — it must NOT come back as undefined', () => {
    // This is the whole point of the knob: `0` disables the quiet-window early
    // resolve so a tail final can still land. Collapsing it to `undefined`
    // silently restores the 250 ms default.
    saveStoredConfig({ ...BASE, drainTimeoutMs: 60_000, quietWindowMs: 0 });
    const cfg = defaultConfig();
    expect(cfg.quietWindowMs).toBe(0);
    expect(cfg.drainTimeoutMs).toBe(60_000);
  });

  it('round-trips ordinary values', () => {
    saveStoredConfig({ ...BASE, drainTimeoutMs: 2500, quietWindowMs: 400 });
    const cfg = defaultConfig();
    expect(cfg.drainTimeoutMs).toBe(2500);
    expect(cfg.quietWindowMs).toBe(400);
  });

  it('clears back to undefined when saved as undefined (reset to SDK defaults)', () => {
    saveStoredConfig({ ...BASE, drainTimeoutMs: 2500, quietWindowMs: 0 });
    expect(defaultConfig().quietWindowMs).toBe(0);

    saveStoredConfig({ ...BASE, drainTimeoutMs: undefined, quietWindowMs: undefined });
    const cfg = defaultConfig();
    expect(cfg.drainTimeoutMs).toBeUndefined();
    expect(cfg.quietWindowMs).toBeUndefined();
  });
});
