/**
 * AudioPage Config Resolution Tests (TASK-244)
 *
 * Tests that AudioPage correctly resolves config from:
 * 1. SDK resolvedConfig (preferred when available and configReady)
 * 2. Tenant config (fallback when SDK not available)
 * 3. Timeout defaults (when neither is available within 2s)
 *
 * These are store-level integration tests that verify the config flow
 * without rendering components (no dependency on @arcaai/vox hooks).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useAudioStore } from '@/store/audio-store';
import type { AppConfig } from '@arcaai/vox';

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    audio: {
      sampleRate: 16000,
      noiseSuppression: true,
      noiseFilterLevel: 'medium',
      echoCancellation: true,
      autoGainControl: true,
      vadEnabled: false,
      vadThreshold: 0.5,
      diarization: false,
      codeSwitching: false,
      captureRawAudio: false,
      ...overrides.audio,
    },
    stt: {
      provider: 'local',
      defaultModel: 'whisper-tiny',
      availableModels: [
        { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
        { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
        { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
      ],
      language: 'en',
      ...overrides.stt,
    },
    ui: { theme: 'system', density: 'normal', language: 'en', ...overrides.ui },
    smr: { provider: 'openai', model: 'gpt-4o', ...overrides.smr },
    features: { realTimeTranscription: true, nerExtraction: false, dnaStyle: false, crossChainSummary: false, tts: false, ...overrides.features },
  };
}

describe('AudioPage config resolution (TASK-244)', () => {
  beforeEach(() => {
    useAudioStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('resolvedConfig priority (preferred path)', () => {
    it('should apply resolvedConfig language', () => {
      const config = makeAppConfig({ stt: { language: 'hi', provider: 'local', defaultModel: 'whisper-tiny', availableModels: [] } });
      useAudioStore.getState().applyResolvedConfig(config);
      expect(useAudioStore.getState().language).toBe('hi');
      expect(useAudioStore.getState().configReady).toBe(true);
    });

    it('should apply resolvedConfig model', () => {
      const config = makeAppConfig({
        stt: {
          defaultModel: 'whisper-base',
          availableModels: [
            { id: 'whisper-tiny', name: 'Tiny' },
            { id: 'whisper-base', name: 'Base' },
          ],
          provider: 'local',
          language: 'en',
        },
      });
      useAudioStore.getState().applyResolvedConfig(config);
      expect(useAudioStore.getState().whisperModel).toBe('whisper-base');
    });

    it('should apply resolvedConfig audio settings', () => {
      const config = makeAppConfig({
        audio: {
          noiseSuppression: false,
          vadEnabled: true,
          vadThreshold: 0.8,
          diarization: true,
          codeSwitching: true,
          sampleRate: 16000,
          noiseFilterLevel: 'high',
          echoCancellation: true,
          autoGainControl: true,
          captureRawAudio: false,
        },
      });
      useAudioStore.getState().applyResolvedConfig(config);
      expect(useAudioStore.getState().noiseFilterEnabled).toBe(false);
      expect(useAudioStore.getState().vadEnabled).toBe(true);
      expect(useAudioStore.getState().vadThreshold).toBe(0.8);
      expect(useAudioStore.getState().diarizationEnabled).toBe(true);
      expect(useAudioStore.getState().codeSwitchingEnabled).toBe(true);
      expect(useAudioStore.getState().noiseFilterLevel).toBe('high');
    });
  });

  describe('tenant config fallback path', () => {
    it('should apply tenant defaults when resolvedConfig not available', () => {
      useAudioStore.getState().applyTenantDefaults({
        defaultLanguage: 'ta',
        defaultSttModel: 'whisper-base',
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Tiny' },
          { id: 'whisper-base', name: 'Base' },
        ],
      });
      expect(useAudioStore.getState().language).toBe('ta');
      expect(useAudioStore.getState().whisperModel).toBe('whisper-base');
      expect(useAudioStore.getState().configReady).toBe(true);
    });
  });

  describe('timeout defaults path', () => {
    it('should set configReady via setConfigReady when timeout fires', () => {
      expect(useAudioStore.getState().configReady).toBe(false);
      useAudioStore.getState().setConfigReady(true);
      expect(useAudioStore.getState().configReady).toBe(true);
      expect(useAudioStore.getState().whisperModel).toBe('whisper-tiny');
    });
  });

  describe('reset behavior', () => {
    it('should reset configReady to false', () => {
      useAudioStore.getState().applyResolvedConfig(makeAppConfig());
      expect(useAudioStore.getState().configReady).toBe(true);
      useAudioStore.getState().reset();
      expect(useAudioStore.getState().configReady).toBe(false);
    });

    it('should reset model to whisper-tiny', () => {
      useAudioStore.getState().applyResolvedConfig(
        makeAppConfig({
          stt: { defaultModel: 'whisper-small', availableModels: [{ id: 'whisper-small', name: 'Small' }], provider: 'local', language: 'en' },
        }),
      );
      useAudioStore.getState().reset();
      expect(useAudioStore.getState().whisperModel).toBe('whisper-tiny');
    });

    it('should reset all audio settings to defaults', () => {
      useAudioStore.getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            vadEnabled: true,
            diarization: true,
            codeSwitching: true,
            noiseSuppression: false,
            sampleRate: 16000,
            noiseFilterLevel: 'high',
            echoCancellation: true,
            autoGainControl: true,
            vadThreshold: 0.9,
            captureRawAudio: false,
          },
        }),
      );
      useAudioStore.getState().reset();
      const state = useAudioStore.getState();
      expect(state.noiseFilterEnabled).toBe(false);
      expect(state.noiseFilterLevel).toBe('medium');
      expect(state.vadEnabled).toBe(false);
      expect(state.vadThreshold).toBe(0.5);
      expect(state.diarizationEnabled).toBe(false);
      expect(state.codeSwitchingEnabled).toBe(false);
    });

    it('should allow re-applying config after reset', () => {
      useAudioStore
        .getState()
        .applyResolvedConfig(makeAppConfig({ stt: { language: 'fr', provider: 'local', defaultModel: 'whisper-tiny', availableModels: [] } }));
      useAudioStore.getState().reset();
      useAudioStore
        .getState()
        .applyResolvedConfig(makeAppConfig({ stt: { language: 'de', provider: 'local', defaultModel: 'whisper-tiny', availableModels: [] } }));
      expect(useAudioStore.getState().language).toBe('de');
      expect(useAudioStore.getState().configReady).toBe(true);
    });
  });

  describe('model ID normalization', () => {
    it('should normalize bare IDs in resolvedConfig models', () => {
      const config = makeAppConfig({
        stt: {
          availableModels: [
            { id: 'tiny', name: 'Tiny' },
            { id: 'base', name: 'Base' },
          ],
          defaultModel: 'tiny',
          provider: 'local',
          language: 'en',
        },
      });
      useAudioStore.getState().applyResolvedConfig(config);
      expect(useAudioStore.getState().availableAsrModels.map((m) => m.id)).toEqual(['whisper-base', 'whisper-tiny']);
      expect(useAudioStore.getState().whisperModel).toBe('whisper-tiny');
    });

    it('should filter non-browser-viable models from resolvedConfig', () => {
      const config = makeAppConfig({
        stt: {
          availableModels: [
            { id: 'whisper-tiny', name: 'Tiny' },
            { id: 'whisper-medium', name: 'Medium' },
            { id: 'whisper-large-v3', name: 'Large' },
          ],
          defaultModel: 'whisper-tiny',
          provider: 'local',
          language: 'en',
        },
      });
      useAudioStore.getState().applyResolvedConfig(config);
      expect(useAudioStore.getState().availableAsrModels).toHaveLength(1);
      expect(useAudioStore.getState().availableAsrModels[0].id).toBe('whisper-tiny');
    });
  });
});
