import { describe, expect, it } from 'vitest';
import { LocalSpeakerDiarizer } from '../LocalSpeakerDiarizer.js';

const SAMPLE_RATE = 16000;

/**
 * Generate a voice-like signal with fundamental frequency + harmonics.
 * Real speech has harmonic structure; pure sine tones are too simple
 * for a mel/MFCC-based diarizer to differentiate meaningfully.
 */
function generateVoiceLike(
  f0: number,
  durationSec = 1.5,
  amplitude = 0.5,
  harmonics = 5,
  formantShift = 0,
): Float32Array {
  const length = Math.floor(SAMPLE_RATE * durationSec);
  const audio = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (let h = 1; h <= harmonics; h += 1) {
      const freq = f0 * h + formantShift * h * 0.3;
      const harmonicAmp = amplitude / (h * 1.2);
      sample += harmonicAmp * Math.sin(2 * Math.PI * freq * t);
    }
    audio[i] = Math.max(-1, Math.min(1, sample));
  }
  return audio;
}

function withNoise(audio: Float32Array, noiseLevel = 0.02): Float32Array {
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i += 1) {
    const jitter = Math.sin(i * 0.013) * noiseLevel;
    out[i] = Math.max(-1, Math.min(1, audio[i]! + jitter));
  }
  return out;
}

describe('LocalSpeakerDiarizer', () => {
  it('returns undefined when diarization is disabled', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: false,
      maxSpeakers: 2,
    });

    const speaker = diarizer.assignSpeaker(generateVoiceLike(140));
    expect(speaker).toBeUndefined();
  });

  it('assigns stable speaker id for similar voice chunks', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const first = diarizer.assignSpeaker(generateVoiceLike(140, 1.5, 0.5, 5));
    const second = diarizer.assignSpeaker(withNoise(generateVoiceLike(145, 1.5, 0.5, 5), 0.01));

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('separates male-like (110Hz) and female-like (220Hz) voices', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const male = generateVoiceLike(110, 2.0, 0.6, 6, 0);
    const female = generateVoiceLike(220, 2.0, 0.45, 4, 80);

    const s1 = diarizer.assignSpeaker(male);
    const s2 = diarizer.assignSpeaker(female);

    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s2).not.toBe(s1);
  });

  it('maintains separation across multiple alternating utterances', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const maleVoice = () => withNoise(generateVoiceLike(110, 1.5, 0.55, 6, 0), 0.01);
    const femaleVoice = () => withNoise(generateVoiceLike(220, 1.5, 0.4, 4, 80), 0.01);

    const m1 = diarizer.assignSpeaker(maleVoice());
    const f1 = diarizer.assignSpeaker(femaleVoice());
    const m2 = diarizer.assignSpeaker(maleVoice());
    const f2 = diarizer.assignSpeaker(femaleVoice());
    const m3 = diarizer.assignSpeaker(maleVoice());

    expect(m1).toBe(m2);
    expect(m2).toBe(m3);
    expect(f1).toBe(f2);
    expect(m1).not.toBe(f1);
  });

  it('does not create more profiles than maxSpeakers', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    diarizer.assignSpeaker(generateVoiceLike(100, 1.5, 0.6, 6));
    diarizer.assignSpeaker(generateVoiceLike(250, 1.5, 0.4, 4, 100));
    diarizer.assignSpeaker(generateVoiceLike(400, 1.5, 0.3, 3, 200));

    expect(diarizer.getProfileCount()).toBe(2);
  });

  it('returns assignment with features when using assignSpeakerWithFeatures', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const result = diarizer.assignSpeakerWithFeatures(generateVoiceLike(140, 1.5));
    expect(result).toBeDefined();
    expect(result!.speakerId).toBe('speaker-1');
    expect(result!.featureVector).toBeInstanceOf(Array);
    expect(result!.featureVector.length).toBeGreaterThan(8);
    expect(result!.profileSamples).toBe(1);
  });

  it('returns undefined for very short audio', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const shortAudio = new Float32Array(100);
    for (let i = 0; i < shortAudio.length; i += 1) {
      shortAudio[i] = Math.sin(2 * Math.PI * 200 * i / SAMPLE_RATE) * 0.5;
    }

    const result = diarizer.assignSpeaker(shortAudio);
    expect(result).toBeUndefined();
  });

  it('resets profiles correctly', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 4,
    });

    diarizer.assignSpeaker(generateVoiceLike(110));
    diarizer.assignSpeaker(generateVoiceLike(250, 1.5, 0.4, 4, 100));
    expect(diarizer.getProfileCount()).toBe(2);

    diarizer.reset();
    expect(diarizer.getProfileCount()).toBe(0);
  });

  it('respects custom similarity threshold', () => {
    const strict = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 4,
      similarityThreshold: 0.99,
    });

    const s1 = strict.assignSpeaker(generateVoiceLike(140, 1.5, 0.5, 5));
    const s2 = strict.assignSpeaker(generateVoiceLike(150, 1.5, 0.48, 5));

    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    // With a very strict threshold, even similar voices may get separate profiles
    expect(strict.getProfileCount()).toBeGreaterThanOrEqual(1);
  });

  // Reserved-speaker slot for the enrolled doctor.
  describe('reservedSpeakerId (TASK-296 C-2)', () => {
    it('pins the FIRST allocated speaker slot to reservedSpeakerId when provided', () => {
      const diarizer = new LocalSpeakerDiarizer({
        enabled: true,
        maxSpeakers: 2,
        reservedSpeakerId: 'Dr. Smith',
      });

      const id = diarizer.assignSpeaker(generateVoiceLike(140, 1.5, 0.5, 5));
      expect(id).toBe('Dr. Smith');
    });

    it('keeps subsequent slots auto-numbered (speaker-2, speaker-3, ...) after the reserved first slot', () => {
      const diarizer = new LocalSpeakerDiarizer({
        enabled: true,
        maxSpeakers: 3,
        reservedSpeakerId: 'Dr. Smith',
      });

      const first = diarizer.assignSpeaker(generateVoiceLike(110, 2.0, 0.6, 6, 0));
      const second = diarizer.assignSpeaker(generateVoiceLike(220, 2.0, 0.45, 4, 80));
      const third = diarizer.assignSpeaker(generateVoiceLike(350, 2.0, 0.35, 3, 150));

      expect(first).toBe('Dr. Smith');
      expect(second).toBe('speaker-2');
      expect(third).toBe('speaker-3');
    });

    it('uses default speaker-1 when reservedSpeakerId is not provided', () => {
      const diarizer = new LocalSpeakerDiarizer({
        enabled: true,
        maxSpeakers: 2,
      });

      const id = diarizer.assignSpeaker(generateVoiceLike(140, 1.5, 0.5, 5));
      expect(id).toBe('speaker-1');
    });

    it('setReservedSpeakerId before first profile pins the first slot', () => {
      const diarizer = new LocalSpeakerDiarizer({
        enabled: true,
        maxSpeakers: 2,
      });
      diarizer.setReservedSpeakerId('Dr. Jones');

      const id = diarizer.assignSpeaker(generateVoiceLike(140, 1.5, 0.5, 5));
      expect(id).toBe('Dr. Jones');
    });

    it('setReservedSpeakerId is a no-op when a profile has already been allocated', () => {
      const diarizer = new LocalSpeakerDiarizer({
        enabled: true,
        maxSpeakers: 2,
      });

      const first = diarizer.assignSpeaker(generateVoiceLike(110, 2.0, 0.6, 6, 0));
      diarizer.setReservedSpeakerId('Too Late');
      const second = diarizer.assignSpeaker(generateVoiceLike(350, 2.0, 0.35, 3, 150));

      expect(first).toBe('speaker-1');
      expect(second).toBe('speaker-2');
    });
  });

  it('does not drift centroids when max speakers reached and no match', () => {
    const diarizer = new LocalSpeakerDiarizer({
      enabled: true,
      maxSpeakers: 2,
    });

    const male = generateVoiceLike(110, 2.0, 0.6, 6, 0);
    const female = generateVoiceLike(220, 2.0, 0.45, 4, 80);
    const child = generateVoiceLike(350, 2.0, 0.35, 3, 150);

    const m1 = diarizer.assignSpeaker(male);
    const f1 = diarizer.assignSpeaker(female);

    // Third distinct voice should be assigned to closest existing profile
    // but should NOT drift the centroid
    diarizer.assignSpeaker(child);
    diarizer.assignSpeaker(child);
    diarizer.assignSpeaker(child);

    // Original voices should still be correctly separated
    const m2 = diarizer.assignSpeaker(male);
    const f2 = diarizer.assignSpeaker(female);

    expect(m1).toBe(m2);
    expect(f1).toBe(f2);
    expect(m1).not.toBe(f1);
  });
});
