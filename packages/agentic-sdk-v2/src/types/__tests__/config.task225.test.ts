/**
 * SDK types extension — LocalWorkflowConfig additions
 *
 * TDD tests for VoiceEmbeddingLocalConfig and AudioSilenceLocalConfig.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import type { LocalWorkflowConfig, VoiceEmbeddingLocalConfig, AudioSilenceLocalConfig } from '../config';

// =============================================================================
// C1: VoiceEmbeddingLocalConfig type
// =============================================================================

describe('VoiceEmbeddingLocalConfig', () => {
  it('should be a valid type with a modelId field', () => {
    const config: VoiceEmbeddingLocalConfig = { modelId: 'pyannote-embedding' };
    expect(config.modelId).toBe('pyannote-embedding');
  });

  it('should allow empty string modelId to indicate disabled', () => {
    const config: VoiceEmbeddingLocalConfig = { modelId: '' };
    expect(config.modelId).toBe('');
  });

  it('should allow "none" modelId to indicate disabled', () => {
    const config: VoiceEmbeddingLocalConfig = { modelId: 'none' };
    expect(config.modelId).toBe('none');
  });
});

// =============================================================================
// C1: AudioSilenceLocalConfig type
// =============================================================================

describe('AudioSilenceLocalConfig', () => {
  it('should be a valid type with a modelId field', () => {
    const config: AudioSilenceLocalConfig = { modelId: 'silero-vad-silence' };
    expect(config.modelId).toBe('silero-vad-silence');
  });

  it('should allow empty string modelId to indicate disabled', () => {
    const config: AudioSilenceLocalConfig = { modelId: '' };
    expect(config.modelId).toBe('');
  });

  it('should allow "none" modelId to indicate disabled', () => {
    const config: AudioSilenceLocalConfig = { modelId: 'none' };
    expect(config.modelId).toBe('none');
  });
});

// =============================================================================
// C1: LocalWorkflowConfig must include the new fields
// =============================================================================

describe('LocalWorkflowConfig extension', () => {
  it('should accept voiceEmbedding in LocalWorkflowConfig', () => {
    const config: LocalWorkflowConfig = {
      noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
      stt: { modelId: 'whisper-large-v3' },
      vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
      ner: { modelId: 'biomedical', autoExtract: true },
      diarization: { enabled: false, autoEnroll: false },
      voiceEmbedding: { modelId: 'pyannote-embedding' },
      audioSilence: { modelId: '' },
      voiceProfile: {},
    };

    expect(config.voiceEmbedding.modelId).toBe('pyannote-embedding');
  });

  it('should accept audioSilence in LocalWorkflowConfig', () => {
    const config: LocalWorkflowConfig = {
      noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
      stt: { modelId: 'whisper-large-v3' },
      vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
      ner: { modelId: 'biomedical', autoExtract: true },
      diarization: { enabled: false, autoEnroll: false },
      voiceEmbedding: { modelId: '' },
      audioSilence: { modelId: 'silero-vad-silence' },
      voiceProfile: {},
    };

    expect(config.audioSilence.modelId).toBe('silero-vad-silence');
  });
});

// DEFAULT_LOCAL_CONFIG was removed under TASK-1006 (the model pins it carried
// described client models the runtime no longer loads at all) — see
// task1006-removed.test.ts for the pinned absence.
