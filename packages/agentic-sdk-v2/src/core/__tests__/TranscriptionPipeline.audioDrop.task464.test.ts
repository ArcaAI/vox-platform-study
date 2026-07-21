/**
 * @arcaai/vox - TranscriptionPipeline audio-drop wiring
 *
 * The push channel is load-bearing: the STT processor exposes a backpressure
 * `onBackpressureDrop` callback (nothing polls the getter). The pipeline must
 * register it on the STT stage and re-emit an `audioDrop` event so the
 * PluginManager → hook → store chain can surface a degraded signal.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionPipeline } from '../TranscriptionPipeline';

// The STT processor mock captures the pipeline's onBackpressureDrop registration
// so the test can fire a drop and assert the pipeline re-emits `audioDrop`.
const sttMocks = vi.hoisted(() => {
  const onBackpressureDrop = vi.fn();
  const processor = {
    init: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onBackpressureDrop,
  };
  return { onBackpressureDrop, processor };
});

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => sttMocks.processor),
}));

describe('TranscriptionPipeline: audio-drop wiring (TASK-464)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildSttOnlyPipeline() {
    return new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'browser', provider: 'local' },
    });
  }

  it('registers onBackpressureDrop on the STT stage and re-emits it as `audioDrop`', async () => {
    const pipeline = buildSttOnlyPipeline();
    const onAudioDrop = vi.fn();
    pipeline.on('audioDrop', onAudioDrop);

    await pipeline.start({
      track: {} as MediaStreamTrack,
      audioContext: {} as AudioContext,
    });

    // The pipeline wired the STT processor's push channel.
    expect(sttMocks.onBackpressureDrop).toHaveBeenCalledTimes(1);
    const registered = sttMocks.onBackpressureDrop.mock.calls[0]![0] as (n: number) => void;
    expect(typeof registered).toBe('function');

    // Firing a drop through the STT processor re-emits `audioDrop` with the count.
    registered(2);

    expect(onAudioDrop).toHaveBeenCalledTimes(1);
    expect(onAudioDrop).toHaveBeenCalledWith(2);
  });
});
