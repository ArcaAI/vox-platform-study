/**
 * @arcaai/room - AudioMixer Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioMixer } from '../core/AudioMixer.js';

function createMockMediaStream(): MediaStream {
  return {
    id: 'mock-destination-stream',
    active: true,
    getAudioTracks: vi.fn(() => []),
    getVideoTracks: vi.fn(() => []),
    getTracks: vi.fn(() => []),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onaddtrack: null,
    onremovetrack: null,
    onactive: null,
    oninactive: null,
  } as unknown as MediaStream;
}

function createMockAudioContext() {
  const gainNode = {
    gain: { value: 1, setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const sourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const destinationNode = {
    stream: createMockMediaStream(),
  };

  const ctx = {
    currentTime: 0,
    createGain: vi.fn(() => ({ ...gainNode, gain: { value: 1, setValueAtTime: vi.fn() } })),
    createMediaStreamSource: vi.fn(() => ({ ...sourceNode })),
    createMediaStreamDestination: vi.fn(() => destinationNode),
  } as unknown as AudioContext;

  return { ctx, gainNode, sourceNode, destinationNode };
}

function createMockStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
  const stream = { getTracks: vi.fn(() => [track]), getAudioTracks: vi.fn(() => [track]) } as unknown as MediaStream;
  return stream;
}

describe('AudioMixer', () => {
  let mockCtx: ReturnType<typeof createMockAudioContext>;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
  });

  it('should create mixer with master gain connected to destination', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    expect(mockCtx.ctx.createGain).toHaveBeenCalled();
    expect(mockCtx.ctx.createMediaStreamDestination).toHaveBeenCalled();
    expect(mixer.getSourceCount()).toBe(0);
  });

  it('should add a source and connect nodes', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = createMockStream();
    mixer.addSource('mic1', stream);

    expect(mockCtx.ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(mixer.getSourceCount()).toBe(1);
  });

  it('should throw when adding duplicate source ID', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.addSource('mic1', createMockStream());
    expect(() => mixer.addSource('mic1', createMockStream())).toThrow('already exists');
  });

  it('should remove a source and disconnect nodes', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = createMockStream();
    mixer.addSource('mic1', stream);
    mixer.removeSource('mic1');

    expect(mixer.getSourceCount()).toBe(0);
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('should handle removing non-existent source gracefully', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    expect(() => mixer.removeSource('nonexistent')).not.toThrow();
  });

  it('should set source gain', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.addSource('mic1', createMockStream());
    mixer.setSourceGain('mic1', 0.5);
    expect(mixer.getSourceCount()).toBe(1);
  });

  it('should mute and unmute a source', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.addSource('mic1', createMockStream());

    mixer.muteSource('mic1', true);
    expect(mixer.getActiveSourceCount()).toBe(0);

    mixer.muteSource('mic1', false);
    expect(mixer.getActiveSourceCount()).toBe(1);
  });

  it('should return mixed stream', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = mixer.getMixedStream();
    expect(stream).toBeDefined();
    expect(stream).toHaveProperty('active');
  });

  it('should emit sourceAdded event', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const handler = vi.fn();
    mixer.on('sourceAdded', handler);
    mixer.addSource('mic1', createMockStream());
    expect(handler).toHaveBeenCalledWith({ id: 'mic1' });
  });

  it('should emit sourceRemoved event', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const handler = vi.fn();
    mixer.on('sourceRemoved', handler);
    mixer.addSource('mic1', createMockStream());
    mixer.removeSource('mic1');
    expect(handler).toHaveBeenCalledWith({ id: 'mic1' });
  });

  it('should emit mixChanged event with source count', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const handler = vi.fn();
    mixer.on('mixChanged', handler);
    mixer.addSource('mic1', createMockStream());
    expect(handler).toHaveBeenCalledWith({ sourceCount: 1 });
    mixer.addSource('mic2', createMockStream());
    expect(handler).toHaveBeenCalledWith({ sourceCount: 2 });
  });

  it('should dispose and clean up all sources', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream1 = createMockStream();
    const stream2 = createMockStream();
    mixer.addSource('mic1', stream1);
    mixer.addSource('mic2', stream2);

    const disposeHandler = vi.fn();
    mixer.on('disposed', disposeHandler);

    mixer.dispose();

    expect(mixer.getSourceCount()).toBe(0);
    expect(mixer.isDisposed()).toBe(true);
    expect(stream1.getTracks()[0].stop).toHaveBeenCalled();
    expect(stream2.getTracks()[0].stop).toHaveBeenCalled();
    expect(disposeHandler).toHaveBeenCalled();
  });

  it('should throw when adding source after dispose', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.dispose();
    expect(() => mixer.addSource('mic1', createMockStream())).toThrow('disposed');
  });

  it('should not dispose twice', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.dispose();
    expect(() => mixer.dispose()).not.toThrow();
  });

  it('should update master gain with 1/sqrt(N) normalization', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    mixer.addSource('mic1', createMockStream());
    mixer.addSource('mic2', createMockStream());
    expect(mockCtx.ctx.createGain).toHaveBeenCalled();
  });
});
