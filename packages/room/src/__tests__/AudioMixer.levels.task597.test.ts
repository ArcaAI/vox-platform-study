/**
 * @arcaai/room — AudioMixer PER-SOURCE level monitoring (TASK-597 follow-up #2).
 *
 * Why this exists: the mixer is the last place in the stack where the inputs
 * are still separate signals. Everything downstream sees one summed track, so
 * "which microphone is speaking" is answerable HERE and nowhere else. These
 * tests pin the four properties the SDK/app rely on:
 *
 *   1. a per-source level really is per-source (two sources, different signals,
 *      different levels — not one shared mixed number),
 *   2. the analyser taps are analysis-only (never connected to the mix),
 *   3. a muted source reads 0,
 *   4. nothing survives `stopLevelMonitoring()` / `dispose()` — no timer, no tap.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioMixer } from '../core/AudioMixer.js';

/** A fake analyser whose time-domain data is a constant amplitude we control. */
interface FakeAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  amplitude: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getFloatTimeDomainData: (buffer: Float32Array) => void;
}

function createMockAudioContext(options: { withAnalyser?: boolean; floatTimeDomain?: boolean } = {}) {
  const { withAnalyser = true, floatTimeDomain = true } = options;
  const analysers: FakeAnalyser[] = [];
  const sourceNodes: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const masterGainConnections: unknown[] = [];

  const createAnalyser = vi.fn(() => {
    const analyser: FakeAnalyser = {
      fftSize: 2048,
      smoothingTimeConstant: 0,
      amplitude: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (buffer: Float32Array) => {
        buffer.fill(analyser.amplitude);
      },
    };
    if (!floatTimeDomain) {
      // A runtime/double without the float read — the mixer must decline rather
      // than run a timer that can only publish zeros.
      (analyser as unknown as { getFloatTimeDomainData?: unknown }).getFloatTimeDomainData = undefined;
    }
    analysers.push(analyser);
    return analyser as unknown as AnalyserNode;
  });

  const ctx = {
    currentTime: 0,
    createGain: vi.fn(() => ({
      gain: { value: 1, setValueAtTime: vi.fn() },
      connect: vi.fn((target: unknown) => masterGainConnections.push(target)),
      disconnect: vi.fn(),
    })),
    createMediaStreamSource: vi.fn(() => {
      const node = { connect: vi.fn(), disconnect: vi.fn() };
      sourceNodes.push(node);
      return node;
    }),
    createMediaStreamDestination: vi.fn(() => ({
      stream: { getAudioTracks: vi.fn(() => []), getTracks: vi.fn(() => []) },
    })),
    ...(withAnalyser ? { createAnalyser } : {}),
  } as unknown as AudioContext;

  return { ctx, analysers, sourceNodes, createAnalyser };
}

function createMockStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
  return { getTracks: vi.fn(() => [track]), getAudioTracks: vi.fn(() => [track]) } as unknown as MediaStream;
}

describe('AudioMixer — per-source level monitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default: no analyser is created and no level is published', () => {
    const { ctx, createAnalyser } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());

    vi.advanceTimersByTime(1000);

    expect(createAnalyser).not.toHaveBeenCalled();
    expect(mixer.isLevelMonitoringActive()).toBe(false);
    expect(mixer.getSourceLevels()).toEqual([{ id: 'source-1', level: 0 }]);
  });

  it('reports a DIFFERENT level per source — the whole point of the feature', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.addSource('source-2', createMockStream());

    const onLevels = vi.fn();
    expect(mixer.startLevelMonitoring({ intervalMs: 100, onLevels })).toBe(true);

    // Loud on mic 1, near-silent on mic 2.
    analysers[0].amplitude = 0.4;
    analysers[1].amplitude = 0.01;
    vi.advanceTimersByTime(100);

    // rms(constant 0.4) = 0.4 → min(100, round(0.4*250)) = 100
    // rms(constant 0.01) → 2, not 3: the buffer is a Float32Array, and 0.01
    // stored as float32 is 0.00999999977…, so rms*250 lands just under 2.5 and
    // rounds DOWN. Pinned as observed rather than as the decimal-arithmetic
    // guess, because the real analyser fills a Float32Array too.
    expect(mixer.getSourceLevel('source-1')).toBe(100);
    expect(mixer.getSourceLevel('source-2')).toBe(2);
    expect(onLevels).toHaveBeenLastCalledWith([
      { id: 'source-1', level: 100 },
      { id: 'source-2', level: 2 },
    ]);

    // Flip which mic is speaking — the levels must follow, not latch.
    analysers[0].amplitude = 0;
    analysers[1].amplitude = 0.2;
    vi.advanceTimersByTime(100);
    expect(mixer.getSourceLevel('source-1')).toBe(0);
    expect(mixer.getSourceLevel('source-2')).toBe(50);
  });

  it('uses the same 0-100 mapping as the SDK mixed meter (rms * 250, capped)', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.startLevelMonitoring({ intervalMs: 50 });

    analysers[0].amplitude = 0.1;
    vi.advanceTimersByTime(50);
    expect(mixer.getSourceLevel('source-1')).toBe(25);

    analysers[0].amplitude = 0.9; // way past the ceiling
    vi.advanceTimersByTime(50);
    expect(mixer.getSourceLevel('source-1')).toBe(100);
  });

  it('taps the SOURCE node and never the destination — analysis adds no playback', () => {
    const { ctx, analysers, sourceNodes } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.startLevelMonitoring();

    // The source node fans out to the gain node AND the analyser…
    expect(sourceNodes[0].connect).toHaveBeenCalledWith(analysers[0]);
    // …and the analyser itself connects to nothing at all.
    expect(analysers[0].connect).not.toHaveBeenCalled();
  });

  it('reports 0 for a muted source, and recovers on unmute', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.startLevelMonitoring({ intervalMs: 100 });

    analysers[0].amplitude = 0.4;
    vi.advanceTimersByTime(100);
    expect(mixer.getSourceLevel('source-1')).toBe(100);

    // Mute calls gainNode.disconnect(); the analyser hangs off the SOURCE node,
    // so it survives — the 0 is the deliberate "not feeding the uplink" answer.
    mixer.muteSource('source-1', true);
    vi.advanceTimersByTime(100);
    expect(mixer.getSourceLevel('source-1')).toBe(0);

    mixer.muteSource('source-1', false);
    vi.advanceTimersByTime(100);
    expect(mixer.getSourceLevel('source-1')).toBe(100);
  });

  it('taps a source added AFTER monitoring started', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.startLevelMonitoring({ intervalMs: 100 });

    mixer.addSource('source-2', createMockStream());
    analysers[1].amplitude = 0.2;
    vi.advanceTimersByTime(100);

    expect(mixer.getSourceLevel('source-2')).toBe(50);
  });

  it('drops a removed source from the published levels', () => {
    const { ctx } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    mixer.addSource('source-2', createMockStream());
    mixer.startLevelMonitoring({ intervalMs: 100 });

    mixer.removeSource('source-1');
    vi.advanceTimersByTime(100);

    expect(mixer.getSourceLevels().map((l) => l.id)).toEqual(['source-2']);
  });

  it('restarts rather than stacking timers when started twice', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());

    const first = vi.fn();
    const second = vi.fn();
    mixer.startLevelMonitoring({ intervalMs: 100, onLevels: first });
    mixer.startLevelMonitoring({ intervalMs: 100, onLevels: second });

    analysers[analysers.length - 1].amplitude = 0.1;
    vi.advanceTimersByTime(100);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stopLevelMonitoring() kills the timer AND every analyser tap', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    const onLevels = vi.fn();
    mixer.startLevelMonitoring({ intervalMs: 100, onLevels });
    vi.advanceTimersByTime(100);
    onLevels.mockClear();

    mixer.stopLevelMonitoring();
    vi.advanceTimersByTime(1000);

    expect(mixer.isLevelMonitoringActive()).toBe(false);
    expect(analysers[0].disconnect).toHaveBeenCalled();
    expect(onLevels).not.toHaveBeenCalled();
  });

  it('dispose() stops monitoring — a level timer must never outlive its mixer', () => {
    const { ctx, analysers } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());
    const onLevels = vi.fn();
    mixer.startLevelMonitoring({ intervalMs: 100, onLevels });
    vi.advanceTimersByTime(100);
    onLevels.mockClear();

    mixer.dispose();
    vi.advanceTimersByTime(1000);

    expect(mixer.isLevelMonitoringActive()).toBe(false);
    expect(analysers[0].disconnect).toHaveBeenCalled();
    expect(onLevels).not.toHaveBeenCalled();
  });

  it('declines (false) on a runtime with no createAnalyser — no timer is started', () => {
    const { ctx } = createMockAudioContext({ withAnalyser: false });
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());

    expect(mixer.startLevelMonitoring()).toBe(false);
    expect(mixer.isLevelMonitoringActive()).toBe(false);
  });

  it('declines (false) when the analyser cannot read float time-domain data', () => {
    const { ctx } = createMockAudioContext({ floatTimeDomain: false });
    const mixer = new AudioMixer(ctx);
    mixer.addSource('source-1', createMockStream());

    expect(mixer.startLevelMonitoring()).toBe(false);
    expect(mixer.isLevelMonitoringActive()).toBe(false);
  });

  it('declines on a disposed mixer', () => {
    const { ctx } = createMockAudioContext();
    const mixer = new AudioMixer(ctx);
    mixer.dispose();
    expect(mixer.startLevelMonitoring()).toBe(false);
  });
});
