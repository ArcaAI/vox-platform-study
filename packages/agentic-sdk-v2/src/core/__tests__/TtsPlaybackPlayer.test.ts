/**
 * TASK-491 — TtsPlaybackPlayer (PCM→float32, resample, ring-buffer feed).
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNode, mockCtx, mockManager } = vi.hoisted(() => {
  const mockNode = {
    port: { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const mockCtx = { sampleRate: 48000, destination: {} };
  const mockManager = {
    acquire: vi.fn(async () => mockCtx),
    resume: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  return { mockNode, mockCtx, mockManager };
});

vi.mock('@arcaai/room', () => ({
  AudioContextManager: { getInstance: vi.fn(() => mockManager) },
}));

vi.mock('../ttsPlaybackWorklet', () => ({
  registerTtsPlaybackWorklet: vi.fn(async () => undefined),
  createTtsPlaybackNode: vi.fn(() => mockNode),
  TTS_PLAYBACK_PROCESSOR_NAME: 'tts-playback-processor',
}));

import { pcm16ToFloat32, resampleLinear, TtsPlaybackPlayer } from '../TtsPlaybackPlayer';

describe('pcm16ToFloat32', () => {
  it('decodes little-endian s16le to [-1, 1] floats', () => {
    // 32767 (0x7FFF) → ~+1, -32768 (0x8000) → -1, 0 → 0
    const bytes = new Uint8Array([0xff, 0x7f, 0x00, 0x80, 0x00, 0x00]);
    const f = pcm16ToFloat32(bytes);
    expect(f.length).toBe(3);
    expect(f[0]).toBeCloseTo(1.0, 3);
    expect(f[1]).toBeCloseTo(-1.0, 3);
    expect(f[2]).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('is a no-op (same reference) when rates match', () => {
    const x = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(x, 24000, 24000)).toBe(x);
  });

  it('doubles the sample count for 24k → 48k', () => {
    const y = resampleLinear(new Float32Array(100), 24000, 48000);
    expect(y.length).toBe(200);
  });
});

describe('TtsPlaybackPlayer lifecycle', () => {
  let player: TtsPlaybackPlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    player = new TtsPlaybackPlayer();
  });

  it('start() acquires the context, registers the worklet, and connects the node', async () => {
    await player.start();
    expect(mockManager.acquire).toHaveBeenCalled();
    expect(mockNode.connect).toHaveBeenCalledWith(mockCtx.destination);
  });

  it('enqueuePcm16() posts a resampled float32 chunk', async () => {
    await player.start();
    player.enqueuePcm16(new Uint8Array(8)); // 4 samples @24k
    expect(mockNode.port.postMessage).toHaveBeenCalledTimes(1);
    const msg = mockNode.port.postMessage.mock.calls[0][0] as { type: string; samples: Float32Array };
    expect(msg.type).toBe('chunk');
    expect(msg.samples).toBeInstanceOf(Float32Array);
  });

  it('carries an odd trailing byte across chunk boundaries', async () => {
    await player.start();
    player.enqueuePcm16(new Uint8Array([1])); // 1 byte → held, nothing posted
    expect(mockNode.port.postMessage).not.toHaveBeenCalled();
    player.enqueuePcm16(new Uint8Array([2, 3])); // merged → 1 whole sample posted, 1 byte held
    expect(mockNode.port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('stop() flushes, disconnects, and releases the context', async () => {
    await player.start();
    await player.stop();
    expect(mockNode.disconnect).toHaveBeenCalled();
    expect(mockManager.release).toHaveBeenCalled();
  });
});
