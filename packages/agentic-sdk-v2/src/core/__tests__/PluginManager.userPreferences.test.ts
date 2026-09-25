/**
 * @arcaai/vox — PluginManager.setUserPreferences wire-up.
 *
 * TASK-1006 (following TASK-865): the local `noiseFilter`/`vad`/`stt.modelId`
 * overrides and the `activeVoiceProfile` -> `stt.voiceProfile` wiring this
 * file used to cover (PluginManager.wave2.test.ts, W2-SDK-1..6) were removed
 * along with the local stages they configured. What survives is the
 * top-level `UserPreferences.language` override — the only preference field
 * `getTranscriptionPipelineConfig()` still reads.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => ({ init: vi.fn(), destroy: vi.fn(), on: vi.fn() })),
}));

describe('PluginManager — setUserPreferences + getTranscriptionPipelineConfig', () => {
  let manager: PluginManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new PluginManager({
      stt: { enabled: true, provider: 'backend', language: 'en-US' },
    });
  });

  it('overrides stt.language from top-level UserPreferences.language', () => {
    manager.setUserPreferences({ language: 'th' });

    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.language).toBe('th');
  });

  it('clears preferences when called with undefined and reverts to static config', () => {
    manager.setUserPreferences({ language: 'th' });
    manager.setUserPreferences(undefined);

    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.language).toBe('en-US');
  });
});
