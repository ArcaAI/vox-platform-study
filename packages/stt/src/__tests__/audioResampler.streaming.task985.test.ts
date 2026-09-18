/**
 * TASK-985 M-53 — the streaming resampler carries kernel context across frames.
 *
 * The defect these pin: `prepareFloat32ForWhisper` is a PURE function whose
 * polyphase kernel zero-pads out-of-range input indices. Called afresh once per
 * ~80 ms capture frame — which is how the streaming provider used it — BOTH
 * edges of every frame are convolved against silence that is not in the signal.
 * The result is a periodic discontinuity in the 16 kHz PCM the ASR receives,
 * roughly twelve times per second of speech.
 *
 * The first attempt at the fix carried only the LEFT history and shipped with
 * these tests green, because the tolerance was loose and the seam assertion was
 * a 1.5x band. It was still wrong: the kernel is symmetric, so the last outputs
 * of every frame were still zero-padded on the RIGHT — the seam had moved from
 * both edges to one rather than gone. Measured against a whole-signal
 * conversion, the error was 0 in each frame's head and 5.6e-2 in its tail.
 *
 * So the assertions below are deliberately absolute rather than tolerant. The
 * windowed conversion computes the same products in the same order as the
 * whole-signal one, so "close enough" is not the claim — EQUAL is, and anything
 * else is a real seam. Do not re-open these into a tolerance band.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { createStreamingResampler, prepareFloat32ForWhisper, resampleSinc, WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';

/** A continuous tone — any seam introduced by framing shows up as a step in it. */
function tone(sampleCount: number, sampleRate: number, hz = 440): Float32Array {
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

function concat(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** Largest absolute sample-to-sample step — the shape a frame seam takes. */
function maxStep(signal: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < signal.length; i++) {
    worst = Math.max(worst, Math.abs(signal[i]! - signal[i - 1]!));
  }
  return worst;
}

/** Push `source` through in `frameLength` chunks and concatenate every output. */
function streamThrough(source: Float32Array, fromRate: number, frameLength: number): Float32Array {
  const resampler = createStreamingResampler(fromRate, WHISPER_SAMPLE_RATE);
  const pieces: Float32Array[] = [];
  for (let offset = 0; offset < source.length; offset += frameLength) {
    pieces.push(resampler.push(source.subarray(offset, offset + frameLength)));
  }
  pieces.push(resampler.flush());
  return concat(pieces);
}

/** The OLD behaviour, reproduced exactly: one pure call per frame. */
function statelessPerFrame(source: Float32Array, fromRate: number, frameLength: number): Float32Array {
  const pieces: Float32Array[] = [];
  for (let offset = 0; offset < source.length; offset += frameLength) {
    pieces.push(prepareFloat32ForWhisper(source.subarray(offset, offset + frameLength), fromRate));
  }
  return concat(pieces);
}

function worstDifference(a: Float32Array, b: Float32Array): { maxDiff: number; index: number } {
  let maxDiff = 0;
  let index = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = Math.abs(a[i]! - b[i]!);
    if (diff > maxDiff) {
      maxDiff = diff;
      index = i;
    }
  }
  return { maxDiff, index };
}

describe('createStreamingResampler (TASK-985 M-53)', () => {
  // The three rate pairs that matter: the common capture rate, one whose period
  // does not divide a ScriptProcessor frame, and an UPSAMPLE (branches > 1,
  // where the right-hand reach is a larger share of a frame — the left-history-
  // only attempt was worst here, at 4.9e-1).
  const cases = [
    { label: '48 kHz capture, 80 ms frames', fromRate: 48_000, frameLength: 3_840, frames: 12 },
    { label: '44.1 kHz capture, ragged 4096-sample frames', fromRate: 44_100, frameLength: 4_096, frames: 12 },
    { label: '8 kHz upsample', fromRate: 8_000, frameLength: 640, frames: 10 },
  ] as const;

  describe.each(cases)('$label', ({ fromRate, frameLength, frames }) => {
    const source = tone(frameLength * frames, fromRate);

    it('produces EXACTLY the samples a whole-signal conversion produces', () => {
      const streamed = streamThrough(source, fromRate, frameLength);
      const whole = resampleSinc(source, fromRate, WHISPER_SAMPLE_RATE);

      // Rate-exact: no accumulated drift, nothing repeated or dropped.
      expect(streamed.length).toBe(whole.length);

      // Not "within a tolerance": the windowed conversion runs the same taps
      // over the same samples in the same order, so any difference at all is a
      // frame boundary leaking into the signal.
      expect(worstDifference(streamed, whole)).toEqual({ maxDiff: 0, index: -1 });
    });

    it('diverges nowhere in a frame — not at its head, and not at its TAIL', () => {
      // The head was already exact when only left history was carried; the tail
      // was not. Asserting per-frame position makes a regression say WHICH edge
      // came back instead of reporting an anonymous number.
      const streamed = streamThrough(source, fromRate, frameLength);
      const whole = resampleSinc(source, fromRate, WHISPER_SAMPLE_RATE);
      const outputsPerFrame = Math.round((frameLength * WHISPER_SAMPLE_RATE) / fromRate);

      let headWorst = 0;
      let tailWorst = 0;
      for (let i = 0; i < Math.min(streamed.length, whole.length); i++) {
        const diff = Math.abs(streamed[i]! - whole[i]!);
        const positionInFrame = i % outputsPerFrame;
        if (positionInFrame < 32) headWorst = Math.max(headWorst, diff);
        if (positionInFrame >= outputsPerFrame - 32) tailWorst = Math.max(tailWorst, diff);
      }

      expect({ headWorst, tailWorst }).toEqual({ headWorst: 0, tailWorst: 0 });
    });

    it('leaves the tone as smooth as a continuous conversion, where the stateless path does not', () => {
      const streamed = streamThrough(source, fromRate, frameLength);
      const stateless = statelessPerFrame(source, fromRate, frameLength);
      const continuous = resampleSinc(source, fromRate, WHISPER_SAMPLE_RATE);

      // Step size is the direct, physical reading of "is there a seam": a
      // zero-padded frame edge shows up as a jump between adjacent samples.
      const continuousStep = maxStep(continuous.subarray(256));
      expect(maxStep(streamed.subarray(256))).toBe(continuousStep);
      // …and the defect this replaced is still clearly visible for contrast.
      expect(maxStep(stateless.subarray(256))).toBeGreaterThan(continuousStep * 2);
    });
  });

  it('holds back a bounded guard region, and flush() releases exactly it', () => {
    // The guard is what gives the last output of a frame its forward kernel
    // support. It is real latency, so it is pinned: at 48 kHz it must stay far
    // under one 80 ms capture frame.
    const FROM = 48_000;
    const FRAME = 3_840;
    const resampler = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);

    const emittedByPush = resampler.push(tone(FRAME, FROM)).length;
    const outputsPerFrame = (FRAME * WHISPER_SAMPLE_RATE) / FROM;

    expect(emittedByPush).toBeLessThan(outputsPerFrame);
    const heldBackSeconds = (outputsPerFrame - emittedByPush) / WHISPER_SAMPLE_RATE;
    expect(heldBackSeconds).toBeLessThan(0.01);

    // And it is not lost: the stream ends with exactly the ideal sample count.
    const tail = resampler.flush().length;
    expect(emittedByPush + tail).toBe(outputsPerFrame);
  });

  it('passes frames straight through when the rates already match', () => {
    const resampler = createStreamingResampler(WHISPER_SAMPLE_RATE, WHISPER_SAMPLE_RATE);
    const frame = tone(320, WHISPER_SAMPLE_RATE);
    expect(resampler.push(frame)).toBe(frame);
    expect(resampler.flush()).toHaveLength(0);
  });

  it('reset() forgets history, so a restarted stream is not convolved against the previous one', () => {
    const FROM = 48_000;
    const FRAME = 3_840;
    const source = tone(FRAME * 3, FROM);

    const fresh = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);
    const firstRun = fresh.push(source.subarray(0, FRAME));

    const reused = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);
    reused.push(source.subarray(FRAME, FRAME * 2));
    reused.reset();
    const afterReset = reused.push(source.subarray(0, FRAME));

    expect(Array.from(afterReset)).toEqual(Array.from(firstRun));
  });
});
