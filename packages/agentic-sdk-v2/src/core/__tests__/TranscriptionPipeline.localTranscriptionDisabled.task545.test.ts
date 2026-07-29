/**
 * TASK-545 — Disable Local (In-Browser) Transcription
 *
 * `LOCAL_TRANSCRIPTION_ENABLED` (`../constants`) is `false` in production —
 * this file exercises the REAL (unmocked) flag so it proves the shipped
 * default, not an opt-in re-enable. `resolveSTTRuntimeProvider()` must never
 * resolve to `'local'` while the flag is off: a backend transport resolves to
 * `'remote'`; with none, it must fail loud (a typed `AgenticError` with code
 * `LOCAL_TRANSCRIPTION_DISABLED`) instead of silently transcribing on-device,
 * and the local Whisper processor must never be constructed.
 *
 * VAD and NoiseFilter are explicitly out of scope for this kill switch (they
 * keep running in the browser as preprocessing stages for the backend
 * stream) — a dedicated test below pins that they still initialize and emit
 * events with STT remote-only.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionPipeline } from '../TranscriptionPipeline';
import { LOCAL_TRANSCRIPTION_ENABLED } from '../constants';
import { AgenticError } from '../../types';
import { createMockLogger } from '../../__tests__/setup';

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
  getProviderType: vi.fn(() => 'remote' as const),
  setStreamingTransport: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

const createNoiseFilter = vi.fn(() => mockNoiseFilter);
const createVAD = vi.fn(() => mockVAD);
const createSTT = vi.fn(() => mockSTT);

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: (...args: unknown[]) => createNoiseFilter(...(args as [])),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: (...args: unknown[]) => createVAD(...(args as [])),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: (...args: unknown[]) => createSTT(...(args as [])),
}));

describe('TranscriptionPipeline: local transcription disabled (TASK-545)', () => {
  const mockTrack = {} as MediaStreamTrack;
  const mockAudioContext = {} as AudioContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ships with the kill switch off', () => {
    expect(LOCAL_TRANSCRIPTION_ENABLED).toBe(false);
  });

  it('returns remote when a streaming transport exists, even with no explicit provider config', async () => {
    const transport = { sessionManager: {}, wsClient: {}, pipelineId: 'pipe-1' };
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto', streamingTransport: transport },
    });

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(createSTT).toHaveBeenCalledWith(expect.objectContaining({ features: expect.objectContaining({ provider: 'remote' }) }));
  });

  it('returns remote when only a legacy sttSocket is configured', async () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto', sttSocket: 'wss://api.example.com/ws/stt/stream' },
    });

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(createSTT).toHaveBeenCalledWith(expect.objectContaining({ features: expect.objectContaining({ provider: 'remote' }) }));
  });

  it('fails loud with LOCAL_TRANSCRIPTION_DISABLED when no transport is configured (the former silent local fallback)', async () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto' },
    });

    const errorHandler = vi.fn();
    pipeline.on('error', errorHandler);

    await expect(pipeline.start({ track: mockTrack, audioContext: mockAudioContext })).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_DISABLED',
    });

    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'LOCAL_TRANSCRIPTION_DISABLED' }) }));
    // The local Whisper processor must never be constructed — no model
    // download side effects while local transcription is disabled.
    expect(createSTT).not.toHaveBeenCalled();
  });

  it('rejects with an AgenticError instance carrying the typed code', async () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto' },
    });

    try {
      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      expect.unreachable('start() should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AgenticError);
      expect((error as InstanceType<typeof AgenticError>).code).toBe('LOCAL_TRANSCRIPTION_DISABLED');
    }
  });

  it('explicit provider: "local" with no transport still fails loud (never resolves local)', async () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'browser', provider: 'local' },
    });

    await expect(pipeline.start({ track: mockTrack, audioContext: mockAudioContext })).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_DISABLED',
    });
    expect(createSTT).not.toHaveBeenCalled();
  });

  it('server config transcriptionMode: LOCAL warns and still fails loud with no transport (provider is never local)', async () => {
    const mockLogger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: false, location: 'browser' },
        stt: { enabled: true, location: 'auto', provider: 'auto', transcriptionMode: 'LOCAL' },
      },
      mockLogger as never,
    );

    await expect(pipeline.start({ track: mockTrack, audioContext: mockAudioContext })).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_DISABLED',
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/disabled platform-wide/i),
      expect.objectContaining({ attributes: expect.objectContaining({ transcriptionMode: 'LOCAL' }) }),
    );
    expect(createSTT).not.toHaveBeenCalled();
  });

  it('server config transcriptionMode: LOCAL resolves remote (with a warning) when a transport IS available', async () => {
    const mockLogger = createMockLogger();
    const transport = { sessionManager: {}, wsClient: {}, pipelineId: 'pipe-1' };
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: false, location: 'browser' },
        stt: { enabled: true, location: 'auto', provider: 'auto', transcriptionMode: 'LOCAL', streamingTransport: transport },
      },
      mockLogger as never,
    );

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(createSTT).toHaveBeenCalledWith(expect.objectContaining({ features: expect.objectContaining({ provider: 'remote' }) }));
  });

  it('transcriptionMode: BACKEND resolves remote without a warning', async () => {
    const mockLogger = createMockLogger();
    const pipeline = new TranscriptionPipeline(
      {
        noiseFilter: { enabled: false, location: 'skip' },
        vad: { enabled: false, location: 'browser' },
        stt: { enabled: true, location: 'auto', provider: 'auto', transcriptionMode: 'BACKEND', sttSocket: 'wss://api.example.com/ws' },
      },
      mockLogger as never,
    );

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(createSTT).toHaveBeenCalledWith(expect.objectContaining({ features: expect.objectContaining({ provider: 'remote' }) }));
  });

  it('VAD and NoiseFilter still initialize and emit level/speech events with STT remote-only', async () => {
    const transport = { sessionManager: {}, wsClient: {}, pipelineId: 'pipe-1' };
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: true, location: 'browser', level: 'high' },
      vad: { enabled: true, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto', streamingTransport: transport },
    });

    const vadHandler = vi.fn();
    pipeline.on('vadEvent', vadHandler);

    await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

    expect(mockNoiseFilter.init).toHaveBeenCalled();
    expect(mockVAD.init).toHaveBeenCalled();
    expect(mockSTT.init).toHaveBeenCalled();
    expect(createSTT).toHaveBeenCalledWith(expect.objectContaining({ features: expect.objectContaining({ provider: 'remote' }) }));

    const vadDataHandler = mockVAD.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (payload: unknown) => void;
    vadDataHandler?.({ type: 'vad-speech-start', data: {}, timestamp: Date.now() });

    expect(vadHandler).toHaveBeenCalledWith(expect.objectContaining({ type: 'speech-start' }));
  });
});
