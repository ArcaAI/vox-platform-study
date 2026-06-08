/**
 * Unit tests for the dual-capture pure helpers (TASK-330 P3, WS3).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  buildDualRecordingInput,
  pickRecorderMimeType,
  RAW_AUDIO_CONSTRAINTS,
  DUAL_CAPTURE_MIME_CANDIDATES,
  DualStreamRecorder,
  type ProcessedAudioTapLike,
} from '../dual-capture';

afterEach(() => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

describe('RAW_AUDIO_CONSTRAINTS', () => {
  it('disables browser DSP so the raw mic signal is preserved', () => {
    expect(RAW_AUDIO_CONSTRAINTS).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe('pickRecorderMimeType', () => {
  it('returns the first supported candidate', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: (t: string) => t === 'audio/webm',
    };
    expect(pickRecorderMimeType()).toBe('audio/webm');
  });

  it('prefers earlier candidates (opus over plain webm)', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => true };
    expect(pickRecorderMimeType()).toBe(DUAL_CAPTURE_MIME_CANDIDATES[0]);
  });

  it('falls back to "" when nothing is supported', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: () => false };
    expect(pickRecorderMimeType()).toBe('');
  });

  it('falls back to "" when MediaRecorder is unavailable', () => {
    expect(pickRecorderMimeType()).toBe('');
  });

  it('honors a custom candidate list', () => {
    const supported = vi.fn((t: string) => t === 'audio/mp4');
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: supported };
    expect(pickRecorderMimeType(['audio/wav', 'audio/mp4'])).toBe('audio/mp4');
  });
});

describe('buildDualRecordingInput', () => {
  it('uses the processed artifact as the canonical mediaId and carries both ids', () => {
    expect(buildDualRecordingInput({ rawMediaId: 'raw-key', processedMediaId: 'proc-key' })).toEqual({
      mediaId: 'proc-key',
      rawMediaId: 'raw-key',
      processedMediaId: 'proc-key',
    });
  });

  it('includes optional duration and language only when provided', () => {
    expect(buildDualRecordingInput({ rawMediaId: 'r', processedMediaId: 'p', durationMs: 4200, language: 'en' })).toEqual({
      mediaId: 'p',
      rawMediaId: 'r',
      processedMediaId: 'p',
      durationMs: 4200,
      language: 'en',
    });
    expect(buildDualRecordingInput({ rawMediaId: 'r', processedMediaId: 'p' })).not.toHaveProperty('durationMs');
  });
});

// ---------------------------------------------------------------------------
// DualStreamRecorder — genuine post-noise-filter tap vs approximation fallback.
// ---------------------------------------------------------------------------

class FakeMediaRecorder {
  static isTypeSupported = vi.fn().mockReturnValue(true);
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? '';
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

const fakeTrack = (id: string) => ({ id, kind: 'audio', stop: vi.fn() }) as unknown as MediaStreamTrack;
const fakeStream = (id: string) => ({ id, getTracks: () => [fakeTrack(id)], getAudioTracks: () => [fakeTrack(id)] }) as unknown as MediaStream;

function makeFakeAudioContext() {
  return {
    state: 'running' as string,
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createBiquadFilter: vi.fn(() => ({ type: '', frequency: { value: 0 }, connect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: fakeStream('approx-dest') })),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

describe('DualStreamRecorder', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  });

  afterEach(() => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it('records the GENUINE processed tap when a factory is provided', async () => {
    const tapStop = vi.fn().mockResolvedValue(undefined);
    const tap: ProcessedAudioTapLike = { stream: fakeStream('processed'), stop: tapStop };
    const processedTapFactory = vi.fn().mockResolvedValue(tap);
    const audioContextFactory = vi.fn(makeFakeAudioContext);
    const input = fakeStream('mic');

    const rec = new DualStreamRecorder(input, { mimeType: 'audio/webm', processedTapFactory, audioContextFactory });
    rec.start();
    expect(rec.isRecording).toBe(true);

    const result = await rec.stop();

    expect(processedTapFactory).toHaveBeenCalledWith(input);
    expect(result?.processedSource).toBe('noise-filter');
    expect(result?.raw).toBeInstanceOf(Blob);
    expect(result?.processed).toBeInstanceOf(Blob);
    expect(tapStop).toHaveBeenCalledTimes(1);
    // Genuine path must NOT build the approximation graph.
    expect(audioContextFactory).not.toHaveBeenCalled();
    expect(rec.isRecording).toBe(false);
  });

  it('falls back to the approximation when the genuine tap factory throws', async () => {
    const ctx = makeFakeAudioContext();
    const audioContextFactory = vi.fn(() => ctx);
    const processedTapFactory = vi.fn().mockRejectedValue(new Error('RNNoise unavailable'));

    const rec = new DualStreamRecorder(fakeStream('mic'), { mimeType: 'audio/webm', processedTapFactory, audioContextFactory });
    rec.start();
    const result = await rec.stop();

    expect(processedTapFactory).toHaveBeenCalledTimes(1);
    expect(result?.processedSource).toBe('approximation');
    expect(result?.processed).toBeInstanceOf(Blob);
    expect(audioContextFactory).toHaveBeenCalledTimes(1);
    expect(ctx.createMediaStreamDestination).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('uses the approximation when no tap factory is provided (backward compatible)', async () => {
    const ctx = makeFakeAudioContext();
    const audioContextFactory = vi.fn(() => ctx);

    const rec = new DualStreamRecorder(fakeStream('mic'), { mimeType: 'audio/webm', audioContextFactory });
    rec.start();
    const result = await rec.stop();

    expect(result?.processedSource).toBe('approximation');
    expect(audioContextFactory).toHaveBeenCalledTimes(1);
  });

  it('returns null from stop() when never started', async () => {
    const rec = new DualStreamRecorder(fakeStream('mic'), { mimeType: 'audio/webm' });
    expect(await rec.stop()).toBeNull();
  });
});
