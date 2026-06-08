/**
 * createProcessedAudioTap Tests — genuine post-noise-filter audio tap.
 *
 * Verifies the SDK helper that exposes the REAL RNNoise-processed PCM as a
 * MediaStream (the same NoiseFilterProcessor the TranscriptionPipeline uses),
 * so a consumer can record the genuine processed audio without driving the full
 * pipeline. Covers: missing-track guard, unsupported-browser guard (so callers
 * can fall back), owned vs borrowed AudioContext lifecycle, level forwarding,
 * and cleanup when the processor never produces a track.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const nf = vi.hoisted(() => {
  const processor = {
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    isUsingFallback: vi.fn(() => false),
    processedTrack: undefined as MediaStreamTrack | undefined,
  };
  const createNoiseFilter = vi.fn(() => processor);
  const getNoiseFilterBrowserSupport = vi.fn(() => ({
    webAssembly: true,
    audioWorklet: true,
    sharedArrayBuffer: true,
    rnnoiseSupported: true,
    nativeFallbackAvailable: true,
    unsupportedReason: undefined as string | undefined,
  }));
  return { processor, createNoiseFilter, getNoiseFilterBrowserSupport };
});

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: nf.createNoiseFilter,
  getNoiseFilterBrowserSupport: nf.getNoiseFilterBrowserSupport,
}));

import { createProcessedAudioTap } from '../ProcessedAudioTap';

const ownedContexts: Array<{ state: string; close: ReturnType<typeof vi.fn> }> = [];

function fakeTrack(id: string): MediaStreamTrack {
  return { id, kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

beforeEach(() => {
  vi.clearAllMocks();
  ownedContexts.length = 0;
  nf.processor.processedTrack = fakeTrack('processed');
  nf.processor.isUsingFallback.mockReturnValue(false);
  nf.getNoiseFilterBrowserSupport.mockReturnValue({
    webAssembly: true,
    audioWorklet: true,
    sharedArrayBuffer: true,
    rnnoiseSupported: true,
    nativeFallbackAvailable: true,
    unsupportedReason: undefined,
  });

  class MockMediaStream {
    private readonly _tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) {
      this._tracks = tracks;
    }
    getAudioTracks(): MediaStreamTrack[] {
      return this._tracks;
    }
    getTracks(): MediaStreamTrack[] {
      return this._tracks;
    }
  }
  class MockAudioContext {
    state = 'running';
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      ownedContexts.push(this);
    }
  }
  vi.stubGlobal('MediaStream', MockMediaStream);
  vi.stubGlobal('AudioContext', MockAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProcessedAudioTap', () => {
  it('throws when the raw stream has no audio track', async () => {
    await expect(createProcessedAudioTap(fakeStream([]))).rejects.toThrow(/no audio track/i);
    expect(nf.createNoiseFilter).not.toHaveBeenCalled();
  });

  it('throws (so the caller can fall back) when RNNoise is unsupported, without creating a context', async () => {
    nf.getNoiseFilterBrowserSupport.mockReturnValue({
      webAssembly: false,
      audioWorklet: false,
      sharedArrayBuffer: false,
      rnnoiseSupported: false,
      nativeFallbackAvailable: false,
      unsupportedReason: 'WebAssembly not supported',
    });

    await expect(createProcessedAudioTap(fakeStream([fakeTrack('mic')]))).rejects.toThrow(/unavailable|WebAssembly/i);
    expect(nf.createNoiseFilter).not.toHaveBeenCalled();
    expect(ownedContexts).toHaveLength(0);
  });

  it('creates the genuine noise filter and exposes the processed MediaStream (owned context)', async () => {
    const micTrack = fakeTrack('mic');
    const tap = await createProcessedAudioTap(fakeStream([micTrack]));

    expect(nf.createNoiseFilter).toHaveBeenCalledWith(
      expect.objectContaining({ noiseCancellation: true, noiseCancellationLevel: 'high' }),
    );
    expect(ownedContexts).toHaveLength(1);
    expect(nf.processor.init).toHaveBeenCalledWith(
      expect.objectContaining({ track: micTrack, audioContext: ownedContexts[0], kind: 'audio' }),
    );
    expect(tap.track).toBe(nf.processor.processedTrack);
    expect(tap.stream.getAudioTracks()).toContain(nf.processor.processedTrack);

    await tap.stop();
    expect(nf.processor.destroy).toHaveBeenCalledTimes(1);
    expect(ownedContexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('borrows a provided AudioContext and does NOT close it on stop', async () => {
    const borrowed = { state: 'running', close: vi.fn().mockResolvedValue(undefined) } as unknown as AudioContext;
    const tap = await createProcessedAudioTap(fakeStream([fakeTrack('mic')]), { audioContext: borrowed });

    expect(ownedContexts).toHaveLength(0);
    expect(nf.processor.init).toHaveBeenCalledWith(expect.objectContaining({ audioContext: borrowed }));

    await tap.stop();
    expect(nf.processor.destroy).toHaveBeenCalledTimes(1);
    expect((borrowed as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
  });

  it('forwards the requested noise-cancellation level', async () => {
    await createProcessedAudioTap(fakeStream([fakeTrack('mic')]), { level: 'medium' });
    expect(nf.createNoiseFilter).toHaveBeenCalledWith(expect.objectContaining({ noiseCancellationLevel: 'medium' }));
  });

  it('tears down and throws when the processor never exposes a processed track', async () => {
    nf.processor.processedTrack = undefined;

    await expect(createProcessedAudioTap(fakeStream([fakeTrack('mic')]))).rejects.toThrow(/processed track/i);
    expect(nf.processor.destroy).toHaveBeenCalledTimes(1);
    expect(ownedContexts[0]!.close).toHaveBeenCalledTimes(1);
  });
});
