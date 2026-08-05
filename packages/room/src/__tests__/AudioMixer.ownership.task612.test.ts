/**
 * @arcaai/room — AudioMixer per-source TRACK OWNERSHIP (TASK-612 Lane B, RC-3).
 *
 * The mixer used to stop a source's tracks on `removeSource()` (and therefore
 * on `dispose()`, which removes every source) unconditionally. That is right
 * for a stream the SDK opened itself — a leaked track keeps the browser's
 * recording indicator lit — but WRONG for a stream the CALLER built and handed
 * in: their next session reuses the same object, finds `readyState: 'ended'`,
 * and streams silence with no error anywhere. That is the ownership inversion
 * RC-3 describes.
 *
 * `addSource` therefore takes an optional per-source
 * {@link AudioMixerAddSourceOptions}. `stopTracksOnRemove` defaults to `true`,
 * so every pre-612 caller keeps today's behaviour byte for byte; passing
 * `false` marks the source CALLER-OWNED — the mixer still unwires the nodes and
 * forgets the source, but never touches its tracks.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioMixer } from '../core/AudioMixer.js';

// ---------------------------------------------------------------------------
// Doubles — a context whose per-source nodes are DISTINCT objects, so "the
// nodes were disconnected" can be asserted for one source without the other's
// spies bleeding into it.
// ---------------------------------------------------------------------------
function createMockAudioContext() {
  const gainNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const sourceNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];

  const ctx = {
    currentTime: 0,
    createGain: vi.fn(() => {
      const node = { gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gainNodes.push(node);
      return node;
    }),
    createMediaStreamSource: vi.fn(() => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    }),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getAudioTracks: () => [], getTracks: () => [] } })),
  } as unknown as AudioContext;

  return { ctx, gainNodes, sourceNodes };
}

interface FakeTrack {
  kind: string;
  label: string;
  readyState: 'live' | 'ended';
  stop: ReturnType<typeof vi.fn>;
}

/** A stream whose track carries a real `readyState`, as a browser reports it. */
function makeStream(label: string) {
  const track: FakeTrack = {
    kind: 'audio',
    label,
    readyState: 'live',
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  };
  return {
    label,
    getTracks: () => [track],
    getAudioTracks: () => [track],
    _track: track,
  };
}

type MixerStream = ReturnType<typeof makeStream>;

const asStream = (s: MixerStream): MediaStream => s as unknown as MediaStream;

describe('AudioMixer — per-source track ownership (TASK-612)', () => {
  let mockCtx: ReturnType<typeof createMockAudioContext>;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
  });

  // -------------------------------------------------------------------------
  // Default = today's behaviour (SDK-owned sources)
  // -------------------------------------------------------------------------
  it('stops a default source\'s tracks on removeSource (unchanged pre-612 behaviour)', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = makeStream('sdk-mic');
    mixer.addSource('mic1', asStream(stream));

    mixer.removeSource('mic1');

    expect(stream._track.stop).toHaveBeenCalledTimes(1);
    expect(stream._track.readyState).toBe('ended');
    expect(mixer.getSourceCount()).toBe(0);
  });

  it('stops a default source\'s tracks on dispose (unchanged pre-612 behaviour)', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = makeStream('sdk-mic');
    mixer.addSource('mic1', asStream(stream));

    mixer.dispose();

    expect(stream._track.stop).toHaveBeenCalledTimes(1);
    expect(stream._track.readyState).toBe('ended');
  });

  it('an explicit stopTracksOnRemove: true is identical to the default', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = makeStream('sdk-mic');
    mixer.addSource('mic1', asStream(stream), 1.0, { stopTracksOnRemove: true });

    mixer.removeSource('mic1');

    expect(stream._track.readyState).toBe('ended');
  });

  // -------------------------------------------------------------------------
  // Opt-out = caller-owned sources
  // -------------------------------------------------------------------------
  it('leaves a caller-owned source\'s tracks LIVE on removeSource, but still unwires and forgets it', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = makeStream('caller-mic');
    mixer.addSource('mic1', asStream(stream), 1.0, { stopTracksOnRemove: false });

    const sourceNode = mockCtx.sourceNodes[0];
    const gainNode = mockCtx.gainNodes[1]; // [0] is the master gain built in the ctor

    mixer.removeSource('mic1');

    // The caller's track is untouched — that is the whole point.
    expect(stream._track.stop).not.toHaveBeenCalled();
    expect(stream._track.readyState).toBe('live');
    // …and the mixer still did everything else it does on a removal.
    expect(sourceNode.disconnect).toHaveBeenCalled();
    expect(gainNode.disconnect).toHaveBeenCalled();
    expect(mixer.getSourceCount()).toBe(0);
  });

  it('leaves a caller-owned source\'s tracks LIVE on dispose', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const stream = makeStream('caller-mic');
    mixer.addSource('mic1', asStream(stream), 1.0, { stopTracksOnRemove: false });

    mixer.dispose();

    expect(stream._track.stop).not.toHaveBeenCalled();
    expect(stream._track.readyState).toBe('live');
    expect(mixer.isDisposed()).toBe(true);
    expect(mixer.getSourceCount()).toBe(0);
  });

  it('emits sourceRemoved for a caller-owned source exactly as for an owned one', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const handler = vi.fn();
    mixer.on('sourceRemoved', handler);
    mixer.addSource('mic1', asStream(makeStream('caller-mic')), 1.0, { stopTracksOnRemove: false });

    mixer.removeSource('mic1');

    expect(handler).toHaveBeenCalledWith({ id: 'mic1' });
  });

  // -------------------------------------------------------------------------
  // The flag is PER SOURCE — a mixed-ownership session is the real one
  // (`useArcaAudio.addSource` can join an SDK-opened mic to an injected mix).
  // -------------------------------------------------------------------------
  it('applies the flag per source: dispose stops only the owned tracks of a mixed-ownership mix', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const callerStream = makeStream('caller-mic');
    const sdkStream = makeStream('sdk-mic');
    mixer.addSource('caller', asStream(callerStream), 1.0, { stopTracksOnRemove: false });
    mixer.addSource('sdk', asStream(sdkStream));

    mixer.dispose();

    expect(callerStream._track.readyState).toBe('live');
    expect(callerStream._track.stop).not.toHaveBeenCalled();
    expect(sdkStream._track.readyState).toBe('ended');
    expect(sdkStream._track.stop).toHaveBeenCalledTimes(1);
  });

  it('applies the flag per source across independent removeSource calls', () => {
    const mixer = new AudioMixer(mockCtx.ctx);
    const callerStream = makeStream('caller-mic');
    const sdkStream = makeStream('sdk-mic');
    mixer.addSource('caller', asStream(callerStream), 1.0, { stopTracksOnRemove: false });
    mixer.addSource('sdk', asStream(sdkStream), 1.0, { stopTracksOnRemove: true });

    mixer.removeSource('sdk');
    expect(sdkStream._track.readyState).toBe('ended');
    expect(callerStream._track.readyState).toBe('live');

    mixer.removeSource('caller');
    expect(callerStream._track.readyState).toBe('live');
    expect(callerStream._track.stop).not.toHaveBeenCalled();
  });
});
