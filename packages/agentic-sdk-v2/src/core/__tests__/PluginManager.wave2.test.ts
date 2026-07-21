/**
 * @arcaai/vox — Wave 2 PluginManager preference wire-up tests.
 *
 * Covers:
 *   • W2-SDK-1 / W2-SDK-2 — `activeVoiceProfile.id` flows into the STT stage as
 *               `voiceProfile.id` + `voiceProfile.reservedSpeakerId` so the local
 *               diarizer can pin the doctor's slot.
 *   • W2-SDK-3 — `localConfig` reaches `getTranscriptionPipelineConfig` instead of
 *               being orphaned in `PersonalizationManager`.
 *   • W2-SDK-4 — `localConfig.noiseCancellation.level` overrides the static
 *               `noiseFilter.level`.
 *   • W2-SDK-5 — `localConfig.vad.sensitivity` overrides the static
 *               `vad.sensitivity`.
 *   • W2-SDK-6 — `localConfig.stt.modelId` overrides the static `stt.modelId`;
 *               top-level `UserPreferences.language` overrides `stt.language`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import type { UserPreferences } from '../../types';

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => ({ init: vi.fn(), destroy: vi.fn(), on: vi.fn() })),
}));
vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => ({ init: vi.fn(), destroy: vi.fn(), on: vi.fn() })),
}));
vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => ({ init: vi.fn(), destroy: vi.fn(), on: vi.fn() })),
}));

describe('PluginManager — Wave 2 (TASK-304 Wave 2)', () => {
  let manager: PluginManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new PluginManager({
      noiseFilter: { enabled: true, level: 'high' },
      vad: { enabled: true, sensitivity: 0.5 },
      stt: { enabled: true, provider: 'local', modelId: 'whisper-tiny', language: 'en-US' },
    });
  });

  describe('setUserPreferences + getTranscriptionPipelineConfig', () => {
    it('exposes a setter and overrides the static stt.modelId', () => {
      const prefs: UserPreferences = {
        localConfig: { stt: { modelId: 'whisper-large-v3' } },
      };
      manager.setUserPreferences(prefs);

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.modelId).toBe('whisper-large-v3');
    });

    it('overrides noiseFilter.level from localConfig.noiseCancellation.level', () => {
      manager.setUserPreferences({
        localConfig: { noiseCancellation: { modelId: 'rnnoise', level: 'low' } },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.noiseFilter.level).toBe('low');
    });

    it('overrides vad.sensitivity from localConfig.vad.sensitivity', () => {
      manager.setUserPreferences({
        localConfig: { vad: { modelId: 'silero-vad-v5', sensitivity: 0.8 } },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.vad.sensitivity).toBe(0.8);
    });

    it('overrides stt.language from top-level UserPreferences.language', () => {
      manager.setUserPreferences({ language: 'th' });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.language).toBe('th');
    });

    it('falls back to the static config when preferences omit a field', () => {
      manager.setUserPreferences({ localConfig: { stt: { modelId: 'whisper-large-v3' } } });

      const cfg = manager.getTranscriptionPipelineConfig();
      // stt.modelId was overridden, but noise level is still the static 'high'.
      expect(cfg.stt.modelId).toBe('whisper-large-v3');
      expect(cfg.noiseFilter.level).toBe('high');
      expect(cfg.vad.sensitivity).toBe(0.5);
    });

    it('clears preferences when called with undefined and reverts to static config', () => {
      manager.setUserPreferences({ localConfig: { stt: { modelId: 'whisper-large-v3' } } });
      manager.setUserPreferences(undefined);

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.modelId).toBe('whisper-tiny');
    });
  });

  describe('activeVoiceProfile wire-up', () => {
    it('forwards activeVoiceProfile.id + a doctor-friendly reservedSpeakerId into stt.voiceProfile', () => {
      manager.setUserPreferences({
        activeVoiceProfile: {
          id: 'profile-uuid-9',
          createdAt: '2026-05-01T00:00:00Z',
        },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.voiceProfile).toBeDefined();
      expect(cfg.stt.voiceProfile?.id).toBe('profile-uuid-9');
      // When no profile label is available, fall back to
      // "Doctor" (display-friendly) rather than the lowercase magic constant.
      expect(cfg.stt.voiceProfile?.reservedSpeakerId).toBe('Doctor');
    });

    it('prefers the profile-supplied label over the "Doctor" fallback', () => {
      manager.setUserPreferences({
        activeVoiceProfile: {
          id: 'profile-uuid-9',
          label: 'Dr. Alice',
          createdAt: '2026-05-01T00:00:00Z',
        },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.voiceProfile?.reservedSpeakerId).toBe('Dr. Alice');
    });

    it('trims whitespace and falls back to "Doctor" for blank labels', () => {
      manager.setUserPreferences({
        activeVoiceProfile: {
          id: 'profile-uuid-9',
          label: '   ',
          createdAt: '2026-05-01T00:00:00Z',
        },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.voiceProfile?.reservedSpeakerId).toBe('Doctor');
    });

    it('forwards localConfig.voiceProfile.similarityThreshold alongside the active profile', () => {
      manager.setUserPreferences({
        activeVoiceProfile: { id: 'profile-uuid-9', createdAt: '2026-05-01T00:00:00Z' },
        localConfig: { voiceProfile: { similarityThreshold: 0.84 } },
      });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.voiceProfile?.similarityThreshold).toBe(0.84);
    });

    it('omits stt.voiceProfile when no active profile and no threshold preference', () => {
      manager.setUserPreferences({ language: 'en-US' });

      const cfg = manager.getTranscriptionPipelineConfig();
      expect(cfg.stt.voiceProfile).toBeUndefined();
    });
  });
});
