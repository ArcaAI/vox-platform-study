import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAudioStore } from '../audio-store';
import type { AppConfig } from '@arcaai/vox';

function getState() {
  return useAudioStore.getState();
}

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
    ui: {
      theme: 'system',
      density: 'normal',
      language: 'en',
      ...overrides.ui,
    },
    smr: {
      provider: 'openai',
      model: 'gpt-4o',
      ...overrides.smr,
    },
    features: {
      realTimeTranscription: true,
      nerExtraction: false,
      dnaStyle: false,
      crossChainSummary: false,
      tts: false,
      ...overrides.features,
    },
  };
}

describe('useAudioStore', () => {
  beforeEach(() => {
    useAudioStore.getState().reset();
  });

  // ===== INITIAL STATE =====

  describe('initial state', () => {
    it('should start with empty sources', () => {
      expect(getState().sources).toEqual([]);
    });

    it('should start with null sourceType', () => {
      expect(getState().sourceType).toBeNull();
    });

    it('should start with noiseFilter disabled', () => {
      expect(getState().noiseFilterEnabled).toBe(false);
    });

    it('should start with noiseFilterLevel medium', () => {
      expect(getState().noiseFilterLevel).toBe('medium');
    });

    it('should start with VAD disabled', () => {
      expect(getState().vadEnabled).toBe(false);
    });

    it('should start with vadThreshold 0.5', () => {
      expect(getState().vadThreshold).toBe(0.5);
    });

    it('should start with diarization disabled', () => {
      expect(getState().diarizationEnabled).toBe(false);
    });

    it('should start with isCapturing false', () => {
      expect(getState().isCapturing).toBe(false);
    });

    it('should start with processingMethod as backend_socket', () => {
      expect(getState().processingMethod).toBe('backend_socket');
    });

    it('should start with no language override (empty string)', () => {
      expect(getState().language).toBe('');
    });

    it('should start with empty transcripts', () => {
      expect(getState().transcripts).toEqual([]);
    });

    it('should start with isMixing false', () => {
      expect(getState().isMixing).toBe(false);
    });

    it('should start with audioLevel 0', () => {
      expect(getState().audioLevel).toBe(0);
    });

    it('should start with isSpeaking false', () => {
      expect(getState().isSpeaking).toBe(false);
    });

    it('should start with speechProbability 0', () => {
      expect(getState().speechProbability).toBe(0);
    });

    it('should start with whisperModel whisper-tiny (TASK-244 normalized)', () => {
      expect(getState().whisperModel).toBe('whisper-tiny');
    });

    it('should start with configReady false (TASK-244)', () => {
      expect(getState().configReady).toBe(false);
    });

    it('should start with 3 browser-viable ASR models using whisper- prefix (TASK-244)', () => {
      const models = getState().availableAsrModels;
      expect(models).toHaveLength(3);
      expect(models.map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small']);
    });
  });

  // ===== MICROPHONE SOURCES =====

  describe('microphone sources', () => {
    it('should add a microphone source', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      const state = getState();
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0].type).toBe('microphone');
      expect(state.sourceType).toBe('microphone');
    });

    it('should not add duplicate microphone by deviceId', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      getState().addMicrophoneSource('dev-1', 'Mic 1 duplicate');
      expect(getState().sources).toHaveLength(1);
    });

    it('should add multiple different microphones', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      getState().addMicrophoneSource('dev-2', 'Mic 2');
      expect(getState().sources).toHaveLength(2);
    });

    it('should remove a microphone source by id', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      getState().addMicrophoneSource('dev-2', 'Mic 2');
      const id = getState().sources[0].id;
      getState().removeMicrophoneSource(id);
      expect(getState().sources).toHaveLength(1);
    });

    it('should reset sourceType to null when all sources removed', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      const id = getState().sources[0].id;
      getState().removeMicrophoneSource(id);
      expect(getState().sourceType).toBeNull();
    });

    it('should update gain on a microphone source', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      const id = getState().sources[0].id;
      getState().updateMicrophoneSource(id, { gain: 0.5 });
      const src = getState().sources[0];
      expect(src.type === 'microphone' && src.gain).toBe(0.5);
    });

    it('should toggle mute on a microphone source', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      const id = getState().sources[0].id;
      getState().updateMicrophoneSource(id, { muted: true });
      const src = getState().sources[0];
      expect(src.type === 'microphone' && src.muted).toBe(true);
    });
  });

  // ===== FILE SOURCE =====

  describe('file source', () => {
    it('should set a file source', () => {
      const file = new File(['audio'], 'test.mp3', { type: 'audio/mpeg' });
      getState().setFileSource(file);
      const state = getState();
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0].type).toBe('file');
      expect(state.sourceType).toBe('file');
    });

    it('should replace previous file source', () => {
      const file1 = new File(['a1'], 'first.mp3', { type: 'audio/mpeg' });
      const file2 = new File(['a2'], 'second.mp3', { type: 'audio/mpeg' });
      getState().setFileSource(file1);
      getState().setFileSource(file2);
      expect(getState().sources).toHaveLength(1);
      expect(getState().sources[0].label).toBe('second.mp3');
    });
  });

  // ===== CLEAR SOURCES =====

  describe('clearSources', () => {
    it('should clear all sources and reset mixing', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      getState().setMixing(true);
      getState().clearSources();
      const state = getState();
      expect(state.sources).toEqual([]);
      expect(state.sourceType).toBeNull();
      expect(state.isMixing).toBe(false);
    });

    it('should stop mixedStream tracks when clearing sources', () => {
      const mockTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
      const mockStream = { getTracks: vi.fn(() => [mockTrack]) } as unknown as MediaStream;
      useAudioStore.setState({ mixedStream: mockStream, sources: [], isMixing: true });
      getState().clearSources();
      expect(mockTrack.stop).toHaveBeenCalled();
      expect(getState().mixedStream).toBeNull();
    });

    it('should not throw when clearSources with null mixedStream', () => {
      useAudioStore.setState({ mixedStream: null });
      expect(() => getState().clearSources()).not.toThrow();
    });
  });

  // ===== AUDIO PROCESSING TOGGLES =====

  describe('toggleNoiseFilter', () => {
    it('should toggle from false to true', () => {
      getState().toggleNoiseFilter();
      expect(getState().noiseFilterEnabled).toBe(true);
    });

    it('should toggle from true to false', () => {
      getState().toggleNoiseFilter();
      getState().toggleNoiseFilter();
      expect(getState().noiseFilterEnabled).toBe(false);
    });
  });

  describe('setNoiseFilterLevel', () => {
    it('should update the level', () => {
      getState().setNoiseFilterLevel('high');
      expect(getState().noiseFilterLevel).toBe('high');
      getState().setNoiseFilterLevel('low');
      expect(getState().noiseFilterLevel).toBe('low');
    });
  });

  describe('toggleVAD', () => {
    it('should toggle the state', () => {
      getState().toggleVAD();
      expect(getState().vadEnabled).toBe(true);
      getState().toggleVAD();
      expect(getState().vadEnabled).toBe(false);
    });
  });

  describe('setVADThreshold', () => {
    it('should update threshold', () => {
      getState().setVADThreshold(0.8);
      expect(getState().vadThreshold).toBe(0.8);
    });

    it('should accept boundary values (0 and 1)', () => {
      getState().setVADThreshold(0);
      expect(getState().vadThreshold).toBe(0);
      getState().setVADThreshold(1);
      expect(getState().vadThreshold).toBe(1);
    });
  });

  describe('toggleDiarization', () => {
    it('should toggle the state', () => {
      getState().toggleDiarization();
      expect(getState().diarizationEnabled).toBe(true);
      getState().toggleDiarization();
      expect(getState().diarizationEnabled).toBe(false);
    });
  });

  describe('processing method', () => {
    it('should set processing method to local_ai', () => {
      getState().setProcessingMethod('local_ai');
      expect(getState().processingMethod).toBe('local_ai');
    });

    it('should set processing method to backend_socket', () => {
      getState().setProcessingMethod('local_ai');
      getState().setProcessingMethod('backend_socket');
      expect(getState().processingMethod).toBe('backend_socket');
    });
  });

  describe('language', () => {
    it('should update language', () => {
      getState().setLanguage('hi-IN');
      expect(getState().language).toBe('hi-IN');
    });
  });

  // ===== TENANT DEFAULTS (TASK-244) =====

  describe('applyTenantDefaults (TASK-244)', () => {
    it('should use defaultSttModel when it exists in browser-viable models', () => {
      getState().applyTenantDefaults({
        defaultSttModel: 'whisper-base',
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny' },
          { id: 'whisper-base', name: 'Whisper Base' },
        ],
      });
      expect(getState().whisperModel).toBe('whisper-base');
    });

    it('should normalize bare IDs to whisper- prefix', () => {
      getState().applyTenantDefaults({
        defaultSttModel: 'base',
        localAsrModels: [
          { id: 'tiny', name: 'Tiny' },
          { id: 'base', name: 'Base' },
        ],
      });
      expect(getState().whisperModel).toBe('whisper-base');
      expect(getState().availableAsrModels.map((m) => m.id)).toEqual(['whisper-base', 'whisper-tiny']);
    });

    it('should filter out non-browser-viable models like whisper-medium', () => {
      getState().applyTenantDefaults({
        localAsrModels: [
          { id: 'whisper-medium', name: 'Whisper Medium' },
          { id: 'whisper-small', name: 'Whisper Small' },
        ],
      });
      expect(getState().availableAsrModels).toEqual([{ id: 'whisper-small', name: 'Whisper Small' }]);
    });

    it('should update availableAsrModels from tenant config (browser-viable only)', () => {
      getState().applyTenantDefaults({
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
          { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
          { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
        ],
      });
      const models = getState().availableAsrModels;
      expect(models).toHaveLength(3);
      expect(models.map((m) => m.id)).toEqual(['whisper-base', 'whisper-small', 'whisper-tiny']);
    });

    it('should fallback to first local model when defaultSttModel is not available', () => {
      getState().applyTenantDefaults({
        defaultSttModel: 'whisper-large-v3',
        localAsrModels: [
          { id: 'whisper-base', name: 'Whisper Base' },
          { id: 'whisper-small', name: 'Whisper Small' },
        ],
      });
      expect(getState().whisperModel).toBe('whisper-base');
    });

    it('should fallback to first model when bare IDs provided', () => {
      getState().applyTenantDefaults({
        localAsrModels: [
          { id: 'base', name: 'Base' },
          { id: 'small', name: 'Small' },
        ],
      });
      expect(getState().whisperModel).toBe('whisper-base');
    });

    it('should set configReady to true after applying tenant defaults', () => {
      expect(getState().configReady).toBe(false);
      getState().applyTenantDefaults({});
      expect(getState().configReady).toBe(true);
    });

    it('should apply vadSensitivity from tenant config', () => {
      getState().applyTenantDefaults({ vadSensitivity: 0.7 });
      expect(getState().vadThreshold).toBe(0.7);
      expect(getState().vadEnabled).toBe(true);
    });

    it('should disable VAD when vadSensitivity is 0', () => {
      getState().applyTenantDefaults({ vadSensitivity: 0 });
      expect(getState().vadEnabled).toBe(false);
    });

    it('should apply codeSwitching from tenant config', () => {
      getState().applyTenantDefaults({ codeSwitching: true });
      expect(getState().codeSwitchingEnabled).toBe(true);
    });

    it('should apply defaultLanguage from tenant config', () => {
      getState().applyTenantDefaults({ defaultLanguage: 'hi' });
      expect(getState().language).toBe('hi');
    });

    it('should handle empty localAsrModels array gracefully', () => {
      getState().applyTenantDefaults({ localAsrModels: [] });
      expect(getState().availableAsrModels).toHaveLength(3);
      expect(getState().whisperModel).toBe('whisper-tiny');
    });

    it('should be idempotent when called twice with same config', () => {
      const config = {
        defaultSttModel: 'whisper-base',
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny' },
          { id: 'whisper-base', name: 'Whisper Base' },
        ],
      };
      getState().applyTenantDefaults(config);
      const stateAfterFirst = { ...getState() };
      getState().applyTenantDefaults(config);
      expect(getState().whisperModel).toBe(stateAfterFirst.whisperModel);
      expect(getState().language).toBe(stateAfterFirst.language);
      expect(getState().configReady).toBe(true);
    });

    it('should handle config with only vadSensitivity', () => {
      getState().applyTenantDefaults({ vadSensitivity: 0.3 });
      expect(getState().vadThreshold).toBe(0.3);
      expect(getState().vadEnabled).toBe(true);
      expect(getState().configReady).toBe(true);
    });

    it('should keep existing models when all tenant models are non-viable', () => {
      getState().applyTenantDefaults({
        localAsrModels: [
          { id: 'whisper-medium', name: 'Medium' },
          { id: 'whisper-large-v3', name: 'Large' },
        ],
      });
      expect(getState().availableAsrModels).toHaveLength(3);
      expect(getState().whisperModel).toBe('whisper-tiny');
    });

    it('should handle mixed prefixed and bare model IDs in same config', () => {
      getState().applyTenantDefaults({
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny' },
          { id: 'base', name: 'Base' },
          { id: 'small', name: 'Small' },
        ],
      });
      const ids = getState().availableAsrModels.map((m) => m.id);
      expect(ids.every((id) => id.startsWith('whisper-'))).toBe(true);
      expect(ids).toHaveLength(3);
    });
  });

  // ===== APPLY RESOLVED CONFIG (TASK-244) =====

  describe('applyResolvedConfig (TASK-244)', () => {
    it('should set configReady to true', () => {
      expect(getState().configReady).toBe(false);
      getState().applyResolvedConfig(makeAppConfig());
      expect(getState().configReady).toBe(true);
    });

    it('should apply language from resolved stt config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({ stt: { language: 'hi', provider: 'local', defaultModel: 'whisper-tiny', availableModels: [] } }),
      );
      expect(getState().language).toBe('hi');
    });

    it('should apply noiseSuppression from resolved audio config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            noiseSuppression: false,
            sampleRate: 16000,
            noiseFilterLevel: 'medium',
            echoCancellation: true,
            autoGainControl: true,
            vadEnabled: false,
            vadThreshold: 0.5,
            diarization: false,
            codeSwitching: false,
            captureRawAudio: false,
          },
        }),
      );
      expect(getState().noiseFilterEnabled).toBe(false);
    });

    it('should apply noiseFilterLevel from resolved audio config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            noiseFilterLevel: 'high',
            sampleRate: 16000,
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
            vadEnabled: false,
            vadThreshold: 0.5,
            diarization: false,
            codeSwitching: false,
            captureRawAudio: false,
          },
        }),
      );
      expect(getState().noiseFilterLevel).toBe('high');
    });

    it('should apply vadEnabled and vadThreshold from resolved config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            vadEnabled: true,
            vadThreshold: 0.8,
            sampleRate: 16000,
            noiseSuppression: true,
            noiseFilterLevel: 'medium',
            echoCancellation: true,
            autoGainControl: true,
            diarization: false,
            codeSwitching: false,
            captureRawAudio: false,
          },
        }),
      );
      expect(getState().vadEnabled).toBe(true);
      expect(getState().vadThreshold).toBe(0.8);
    });

    it('should apply diarization from resolved config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            diarization: true,
            sampleRate: 16000,
            noiseSuppression: true,
            noiseFilterLevel: 'medium',
            echoCancellation: true,
            autoGainControl: true,
            vadEnabled: false,
            vadThreshold: 0.5,
            codeSwitching: false,
            captureRawAudio: false,
          },
        }),
      );
      expect(getState().diarizationEnabled).toBe(true);
    });

    it('should apply codeSwitching from resolved config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          audio: {
            codeSwitching: true,
            sampleRate: 16000,
            noiseSuppression: true,
            noiseFilterLevel: 'medium',
            echoCancellation: true,
            autoGainControl: true,
            vadEnabled: false,
            vadThreshold: 0.5,
            diarization: false,
            captureRawAudio: false,
          },
        }),
      );
      expect(getState().codeSwitchingEnabled).toBe(true);
    });

    it('should apply defaultModel from resolved stt config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            defaultModel: 'whisper-base',
            availableModels: [
              { id: 'whisper-tiny', name: 'Whisper Tiny' },
              { id: 'whisper-base', name: 'Whisper Base' },
            ],
            provider: 'local',
            language: 'en',
          },
        }),
      );
      expect(getState().whisperModel).toBe('whisper-base');
    });

    it('should filter non-browser-viable models from resolved config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            availableModels: [
              { id: 'whisper-tiny', name: 'Whisper Tiny' },
              { id: 'whisper-medium', name: 'Whisper Medium' },
              { id: 'whisper-large-v3', name: 'Whisper Large V3' },
            ],
            provider: 'local',
            defaultModel: 'whisper-tiny',
            language: 'en',
          },
        }),
      );
      expect(getState().availableAsrModels.map((m) => m.id)).toEqual(['whisper-tiny']);
    });

    it('should fallback to first viable model if defaultModel is not browser-viable', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            defaultModel: 'whisper-large-v3',
            availableModels: [
              { id: 'whisper-small', name: 'Whisper Small' },
              { id: 'whisper-base', name: 'Whisper Base' },
            ],
            provider: 'local',
            language: 'en',
          },
        }),
      );
      expect(getState().whisperModel).toBe('whisper-base');
    });

    it('should not change values when resolved config matches current state', () => {
      getState().applyResolvedConfig(makeAppConfig());
      const firstState = { ...getState() };
      getState().applyResolvedConfig(makeAppConfig());
      expect(getState().language).toBe(firstState.language);
      expect(getState().whisperModel).toBe(firstState.whisperModel);
    });

    it('should keep existing models when resolved config has no viable models', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            availableModels: [{ id: 'whisper-large-v3', name: 'Large' }],
            provider: 'local',
            defaultModel: 'whisper-large-v3',
            language: 'en',
          },
        }),
      );
      expect(getState().availableAsrModels).toHaveLength(3);
      expect(getState().whisperModel).toBe('whisper-tiny');
    });

    it('should handle empty availableModels in resolved config', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            availableModels: [],
            provider: 'local',
            defaultModel: 'whisper-tiny',
            language: 'en',
          },
        }),
      );
      expect(getState().availableAsrModels).toHaveLength(3);
      expect(getState().whisperModel).toBe('whisper-tiny');
    });
  });

  // ===== CONFIG READY (TASK-244) =====

  describe('setConfigReady (TASK-244)', () => {
    it('should set configReady to true', () => {
      getState().setConfigReady(true);
      expect(getState().configReady).toBe(true);
    });

    it('should set configReady back to false', () => {
      getState().setConfigReady(true);
      getState().setConfigReady(false);
      expect(getState().configReady).toBe(false);
    });
  });

  // ===== TRANSCRIPTION =====

  describe('transcription', () => {
    const makeEntry = (overrides = {}) => ({
      id: 'tx-1',
      segment: 0,
      text: 'Hello world',
      timestamp: Date.now(),
      isFinal: true,
      start: 0,
      end: 1,
      duration: 1,
      inference: 50,
      ...overrides,
    });

    it('should add a transcript entry', () => {
      getState().addTranscript(makeEntry());
      expect(getState().transcripts).toHaveLength(1);
    });

    it('should accumulate multiple transcript entries', () => {
      getState().addTranscript(makeEntry({ id: 'tx-1' }));
      getState().addTranscript(makeEntry({ id: 'tx-2', text: 'World' }));
      expect(getState().transcripts).toHaveLength(2);
    });

    it('should replace partial transcripts', () => {
      getState().addTranscript(makeEntry({ id: 'tx-1', isFinal: true }));
      getState().addTranscript(makeEntry({ id: 'tx-2', text: 'Wor', isFinal: false }));
      getState().replacePartialTranscript(makeEntry({ id: 'tx-3', text: 'World', isFinal: false }));
      const transcripts = getState().transcripts;
      expect(transcripts).toHaveLength(2);
      expect(transcripts[1].text).toBe('World');
    });

    it('should clear all transcripts', () => {
      getState().addTranscript(makeEntry());
      getState().clearTranscripts();
      expect(getState().transcripts).toEqual([]);
    });
  });

  // ===== MIXING =====

  describe('mixing', () => {
    it('should toggle mixing state', () => {
      getState().setMixing(true);
      expect(getState().isMixing).toBe(true);
    });
  });

  // ===== AUDIO LEVEL AND VAD STATE =====

  describe('audio level and VAD state', () => {
    it('should update audio level', () => {
      getState().setAudioLevel(0.75);
      expect(getState().audioLevel).toBe(0.75);
    });

    it('should update speaking state', () => {
      getState().setSpeaking(true);
      expect(getState().isSpeaking).toBe(true);
    });

    it('should update speech probability', () => {
      getState().setSpeechProbability(0.92);
      expect(getState().speechProbability).toBe(0.92);
    });
  });

  // ===== WEBSOCKET STREAMING STATE =====

  describe('WebSocket streaming state', () => {
    it('should start with wsStatus idle', () => {
      expect(getState().wsStatus).toBe('idle');
    });

    it('should update wsStatus', () => {
      getState().setWsStatus('connecting');
      expect(getState().wsStatus).toBe('connecting');
      getState().setWsStatus('streaming');
      expect(getState().wsStatus).toBe('streaming');
    });

    it('should update wsSessionId', () => {
      getState().setWsSessionId('session-abc');
      expect(getState().wsSessionId).toBe('session-abc');
    });

    it('should update wsReconnectAttempts', () => {
      getState().setWsReconnectAttempts(3);
      expect(getState().wsReconnectAttempts).toBe(3);
    });

    it('should track bytesSent cumulatively', () => {
      getState().addBytesSent(1024);
      expect(getState().bytesSent).toBe(1024);
      getState().addBytesSent(2048);
      expect(getState().bytesSent).toBe(3072);
    });
  });

  // ===== SSE FILE TRANSCRIPTION STATE =====

  describe('SSE file transcription state', () => {
    it('should start with sseStatus idle', () => {
      expect(getState().sseStatus).toBe('idle');
    });

    it('should update sseStatus', () => {
      getState().setSseStatus('uploading');
      expect(getState().sseStatus).toBe('uploading');
      getState().setSseStatus('complete');
      expect(getState().sseStatus).toBe('complete');
    });

    it('should update sseJobId', () => {
      getState().setSseJobId('job-123');
      expect(getState().sseJobId).toBe('job-123');
    });

    it('should update uploadProgress', () => {
      getState().setUploadProgress(50);
      expect(getState().uploadProgress).toBe(50);
    });
  });

  // ===== MIXED STREAM TRACK CLEANUP =====

  describe('setMixedStream - track cleanup', () => {
    it('should stop tracks on previous stream when setting new stream', () => {
      const oldTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
      const oldStream = { getTracks: vi.fn(() => [oldTrack]) } as unknown as MediaStream;
      const newStream = { getTracks: vi.fn(() => []) } as unknown as MediaStream;
      useAudioStore.setState({ mixedStream: oldStream });
      getState().setMixedStream(newStream);
      expect(oldTrack.stop).toHaveBeenCalled();
      expect(getState().mixedStream).toBe(newStream);
    });

    it('should not stop tracks when setting same stream', () => {
      const mockTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
      const mockStream = { getTracks: vi.fn(() => [mockTrack]) } as unknown as MediaStream;
      useAudioStore.setState({ mixedStream: mockStream });
      getState().setMixedStream(mockStream);
      expect(mockTrack.stop).not.toHaveBeenCalled();
    });
  });

  // ===== RESET =====

  describe('reset', () => {
    it('should restore all values to defaults', () => {
      getState().addMicrophoneSource('dev-1', 'Mic 1');
      getState().toggleNoiseFilter();
      getState().setNoiseFilterLevel('high');
      getState().toggleVAD();
      getState().setVADThreshold(0.9);
      getState().toggleDiarization();
      getState().toggleCodeSwitching();
      getState().setCapturing(true);
      getState().setProcessingMethod('local_ai');
      getState().setLanguage('hi-IN');
      getState().setWhisperModel('whisper-base');
      getState().setConfigReady(true);
      getState().setWsStatus('streaming');
      getState().setWsSessionId('session-1');
      getState().setWsReconnectAttempts(3);
      getState().addBytesSent(5000);
      getState().setSseStatus('streaming');
      getState().setSseJobId('job-1');
      getState().setUploadProgress(80);

      getState().reset();

      const state = getState();
      expect(state.sources).toEqual([]);
      expect(state.sourceType).toBeNull();
      expect(state.noiseFilterEnabled).toBe(false);
      expect(state.noiseFilterLevel).toBe('medium');
      expect(state.vadEnabled).toBe(false);
      expect(state.vadThreshold).toBe(0.5);
      expect(state.diarizationEnabled).toBe(false);
      expect(state.codeSwitchingEnabled).toBe(false);
      expect(state.isCapturing).toBe(false);
      expect(state.processingMethod).toBe('backend_socket');
      expect(state.language).toBe('');
      expect(state.transcripts).toEqual([]);
      expect(state.isMixing).toBe(false);
      expect(state.audioLevel).toBe(0);
      expect(state.isSpeaking).toBe(false);
      expect(state.speechProbability).toBe(0);
      expect(state.whisperModel).toBe('whisper-tiny');
      expect(state.configReady).toBe(false);
      expect(state.wsStatus).toBe('idle');
      expect(state.wsSessionId).toBeNull();
      expect(state.wsReconnectAttempts).toBe(0);
      expect(state.bytesSent).toBe(0);
      expect(state.sseStatus).toBe('idle');
      expect(state.sseJobId).toBeNull();
      expect(state.uploadProgress).toBe(0);
    });

    it('should stop mixedStream tracks on reset', () => {
      const mockTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
      const mockStream = { getTracks: vi.fn(() => [mockTrack]) } as unknown as MediaStream;
      useAudioStore.setState({ mixedStream: mockStream });
      getState().reset();
      expect(mockTrack.stop).toHaveBeenCalled();
    });

    it('configReady is false after reset following applyTenantDefaults', () => {
      getState().applyTenantDefaults({
        defaultSttModel: 'whisper-base',
        localAsrModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny' },
          { id: 'whisper-base', name: 'Whisper Base' },
        ],
      });
      expect(getState().configReady).toBe(true);
      getState().reset();
      expect(getState().configReady).toBe(false);
      expect(getState().whisperModel).toBe('whisper-tiny');
    });

    it('configReady is false after reset following applyResolvedConfig', () => {
      getState().applyResolvedConfig(
        makeAppConfig({
          stt: {
            defaultModel: 'whisper-small',
            availableModels: [{ id: 'whisper-small', name: 'Small' }],
            provider: 'local',
            language: 'en',
          },
        }),
      );
      expect(getState().configReady).toBe(true);
      getState().reset();
      expect(getState().configReady).toBe(false);
    });
  });
});
