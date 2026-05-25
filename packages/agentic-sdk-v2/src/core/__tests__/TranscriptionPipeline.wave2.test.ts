/**
 * TASK-304 Wave 2 — TranscriptionPipeline → createSTT wire-up tests
 *
 * Verifies that the new STT config surface added in Wave 2C
 * (`voiceProfile`, `task`) is forwarded from
 * `TranscriptionPipelineConfig.stt` into `createSTT` exactly once, without
 * leaking into the remote-only `sttSocket` path or polluting unrelated
 * features.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptionPipeline } from '../TranscriptionPipeline';
import type { TranscriptionPipelineConfig } from '../../types/pipeline';
import { createSTT } from '@arcaai/stt';

const mockNoiseFilter = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

const mockVAD = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

const mockSTT = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  getProviderType: vi.fn(() => 'local' as const),
  transcribeSegment: vi.fn().mockResolvedValue({ text: '', isFinal: true }),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => mockNoiseFilter),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => mockVAD),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => mockSTT),
}));

describe('TranscriptionPipeline · Wave 2 STT options forwarding', () => {
  const mockTrack = {} as MediaStreamTrack;
  const mockAudioContext = {} as AudioContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSTT.init.mockResolvedValue(undefined);
    mockSTT.getProviderType.mockReturnValue('local');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards stt.voiceProfile and stt.task into createSTT for local provider', async () => {
    const config: Partial<TranscriptionPipelineConfig> = {
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: {
        enabled: true,
        location: 'browser',
        provider: 'local',
        modelId: 'whisper-small',
        task: 'translate',
        voiceProfile: {
          id: 'profile-1',
          reservedSpeakerId: 'doctor',
          similarityThreshold: 0.92,
        },
      },
    };
    const pipeline = new TranscriptionPipeline(config);

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(createSTT).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(createSTT).mock.calls[0]?.[0];
    expect(callArgs?.features?.task).toBe('translate');
    expect(callArgs?.voiceProfile).toEqual({
      id: 'profile-1',
      reservedSpeakerId: 'doctor',
      similarityThreshold: 0.92,
    });
  });

  it('omits voiceProfile and task when the SDK has no preferences for them', async () => {
    const config: Partial<TranscriptionPipelineConfig> = {
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: {
        enabled: true,
        location: 'browser',
        provider: 'local',
        modelId: 'whisper-tiny',
      },
    };
    const pipeline = new TranscriptionPipeline(config);

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    const callArgs = vi.mocked(createSTT).mock.calls[0]?.[0];
    expect(callArgs?.features?.task).toBeUndefined();
    expect(callArgs?.voiceProfile).toBeUndefined();
  });

  it('forwards only similarityThreshold when the user has tuned the threshold without enrolling', async () => {
    const config: Partial<TranscriptionPipelineConfig> = {
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: {
        enabled: true,
        location: 'browser',
        provider: 'local',
        voiceProfile: { similarityThreshold: 0.85 },
      },
    };
    const pipeline = new TranscriptionPipeline(config);

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    const callArgs = vi.mocked(createSTT).mock.calls[0]?.[0];
    expect(callArgs?.voiceProfile).toEqual({ similarityThreshold: 0.85 });
    expect(callArgs?.voiceProfile?.id).toBeUndefined();
    expect(callArgs?.voiceProfile?.reservedSpeakerId).toBeUndefined();
  });
});
