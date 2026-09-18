/**
 * TASK-985 M-53 — the streaming resampler keeps kernel history across frames.
 *
 * The defect these pin: `prepareFloat32ForWhisper` is a PURE function whose
 * polyphase kernel zero-pads out-of-range input indices. Called afresh once per
 * ~80 ms capture frame — which is how the streaming provider used it — the
 * first and last ~one-kernel-half of EVERY frame are convolved against silence
 * that is not in the signal. The result is a periodic discontinuity in the
 * 16 kHz PCM the ASR receives, roughly twelve times per second of speech.
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

describe('createStreamingResampler (TASK-985 M-53)', () => {
  it('frame-by-frame output matches resampling the whole signal at once', () => {
    const FROM = 48_000;
    const FRAME = 3_840; // 80 ms at 48 kHz — the capture cadence
    const source = tone(FRAME * 12, FROM);

    const resampler = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);
    const streamed: Float32Array[] = [];
    for (let offset = 0; offset < source.length; offset += FRAME) {
      streamed.push(resampler.push(source.subarray(offset, offset + FRAME)));
    }
    const streamedOut = concat([...streamed, resampler.flush()]);
    const wholeOut = resampleSinc(source, FROM, WHISPER_SAMPLE_RATE);

    // Rate-exact: no accumulated drift, no repeated or dropped samples.
    expect(streamedOut.length).toBe(wholeOut.length);

    // Interior samples agree closely with the one-shot conversion. Only the
    // leading edge legitimately differs (the true start of the stream IS
    // preceded by silence), so the comparison starts past one kernel.
    const skip = 256;
    let worst = 0;
    for (let i = skip; i < wholeOut.length; i++) {
      worst = Math.max(worst, Math.abs(streamedOut[i]! - wholeOut[i]!));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('removes the per-frame seam the stateless path stamps into a continuous tone', () => {
    const FROM = 48_000;
    const FRAME = 3_840;
    const source = tone(FRAME * 8, FROM);

    const resampler = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);
    const streamedOut = concat(
      Array.from({ length: source.length / FRAME }, (_unused, index) => resampler.push(source.subarray(index * FRAME, (index + 1) * FRAME))),
    );

    // The OLD behaviour, reproduced exactly: one pure call per frame.
    const statelessOut = concat(
      Array.from({ length: source.length / FRAME }, (_unused, index) =>
        prepareFloat32ForWhisper(source.subarray(index * FRAME, (index + 1) * FRAME), FROM),
      ),
    );

    // A 440 Hz tone at 16 kHz steps at most ~0.17 between adjacent samples.
    // The stateless path's zero-padded frame edges produce a much larger jump;
    // the streaming path must not.
    const continuousStep = maxStep(resampleSinc(source, FROM, WHISPER_SAMPLE_RATE).subarray(256));
    expect(maxStep(streamedOut.subarray(256))).toBeLessThan(continuousStep * 1.5);
    expect(maxStep(statelessOut.subarray(256))).toBeGreaterThan(continuousStep * 2);
  });

  it('is rate-exact across ragged frame sizes (a ScriptProcessor does not hand you whole periods)', () => {
    const FROM = 44_100; // step = 441, so a 4096-sample frame is NOT a whole number of periods
    const FRAME = 4_096;
    const FRAMES = 20;
    const source = tone(FRAME * FRAMES, FROM);

    const resampler = createStreamingResampler(FROM, WHISPER_SAMPLE_RATE);
    let produced = 0;
    for (let index = 0; index < FRAMES; index++) {
      produced += resampler.push(source.subarray(index * FRAME, (index + 1) * FRAME)).length;
    }
    produced += resampler.flush().length;

    // Rounding a partial period per frame would shed a fraction of a sample
    // each time and drift the timeline over a consultation.
    const ideal = Math.round((source.length * WHISPER_SAMPLE_RATE) / FROM);
    expect(Math.abs(produced - ideal)).toBeLessThanOrEqual(1);
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
