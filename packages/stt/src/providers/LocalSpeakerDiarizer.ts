/**
 * Lightweight local speaker diarization helper.
 *
 * Uses a ~40-dimensional feature vector built from mel-scale sub-band
 * energies, MFCCs, spectral shape descriptors, and pitch features.
 * Intended as a browser-only fallback when a neural voice-embedding
 * model is not available.
 */

export interface LocalSpeakerDiarizerOptions {
  enabled: boolean;
  maxSpeakers: number;
  similarityThreshold?: number;
  /**
   * When set, the FIRST allocated speaker slot's id is pinned to this value
   * instead of the default `speaker-1`. Subsequent slots stay
   * sequentially numbered (`speaker-2`, `speaker-3`, ...).
   *
   * Short-term workaround for the 40-d MFCC vs 256-d backend embedding
   * mismatch — gives the doctor a stable label even though the local
   * diarizer cannot consume the backend embedding directly.
   */
  reservedSpeakerId?: string;
}

export interface LocalSpeakerAssignment {
  speakerId: string;
  featureVector: number[];
  profileSamples: number;
  similarity?: number;
}

interface SpeakerProfile {
  id: string;
  centroid: Float32Array;
  samples: number;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.97;
const DEFAULT_MAX_SPEAKERS = 2;
const FEATURE_FRAME_SIZE = 2048;
const NUM_MEL_BANDS = 24;
const NUM_MFCC = 13;
const MIN_AUDIO_SAMPLES = 512;
const ASSUMED_SAMPLE_RATE = 16000;
const CENTROID_MAX_SAMPLES = 20;

export class LocalSpeakerDiarizer {
  private readonly enabled: boolean;
  private readonly maxSpeakers: number;
  private readonly similarityThreshold: number;
  private readonly profiles: SpeakerProfile[] = [];
  private reservedSpeakerId?: string;

  constructor(options: LocalSpeakerDiarizerOptions) {
    this.enabled = options.enabled;
    this.maxSpeakers = Math.max(1, options.maxSpeakers || DEFAULT_MAX_SPEAKERS);
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.reservedSpeakerId = options.reservedSpeakerId;
  }

  /**
   * Set / replace the doctor-reserved speaker id used for the FIRST
   * allocated speaker slot. No-op if a profile has already been allocated
   * (the first slot is fixed at creation time).
   */
  setReservedSpeakerId(id: string | undefined): void {
    if (this.profiles.length === 0) {
      this.reservedSpeakerId = id;
    }
  }

  assignSpeaker(audio: Float32Array): string | undefined {
    const assignment = this.assignSpeakerWithFeatures(audio);
    return assignment?.speakerId;
  }

  assignSpeakerWithFeatures(audio: Float32Array): LocalSpeakerAssignment | undefined {
    if (!this.enabled || audio.length < MIN_AUDIO_SAMPLES) {
      return undefined;
    }

    const feature = this.extractFeatureVector(audio);
    if (!feature) {
      return undefined;
    }

    if (this.profiles.length === 0) {
      const created = this.createProfile(feature);
      return {
        speakerId: created.id,
        featureVector: Array.from(feature),
        profileSamples: created.samples,
      };
    }

    let bestProfile: SpeakerProfile | null = null;
    let bestScore = -1;

    for (const profile of this.profiles) {
      const score = this.cosineSimilarity(feature, profile.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestProfile = profile;
      }
    }

    if (bestProfile && bestScore >= this.similarityThreshold) {
      this.updateProfile(bestProfile, feature);
      return {
        speakerId: bestProfile.id,
        featureVector: Array.from(feature),
        profileSamples: bestProfile.samples,
        similarity: bestScore,
      };
    }

    if (this.profiles.length < this.maxSpeakers) {
      const created = this.createProfile(feature);
      return {
        speakerId: created.id,
        featureVector: Array.from(feature),
        profileSamples: created.samples,
      };
    }

    // Max speakers reached and no match above threshold.
    // Assign to best match but do NOT update the centroid — this avoids
    // centroid drift that merges distinct speakers over time.
    if (bestProfile) {
      return {
        speakerId: bestProfile.id,
        featureVector: Array.from(feature),
        profileSamples: bestProfile.samples,
        similarity: bestScore,
      };
    }

    const created = this.createProfile(feature);
    return {
      speakerId: created.id,
      featureVector: Array.from(feature),
      profileSamples: created.samples,
    };
  }

  reset(): void {
    this.profiles.length = 0;
  }

  getProfileCount(): number {
    return this.profiles.length;
  }

  private createProfile(feature: Float32Array): SpeakerProfile {
    const id = this.profiles.length === 0 && this.reservedSpeakerId ? this.reservedSpeakerId : `speaker-${this.profiles.length + 1}`;
    const profile: SpeakerProfile = {
      id,
      centroid: feature.slice(),
      samples: 1,
    };
    this.profiles.push(profile);
    return profile;
  }

  private updateProfile(profile: SpeakerProfile, feature: Float32Array): void {
    const alpha = 1 / Math.min(profile.samples + 1, CENTROID_MAX_SAMPLES);
    for (let i = 0; i < profile.centroid.length; i += 1) {
      profile.centroid[i] = (1 - alpha) * profile.centroid[i]! + alpha * feature[i]!;
    }
    this.normalizeInPlace(profile.centroid);
    profile.samples += 1;
  }

  // ─── Feature extraction ──────────────────────────────────────────────

  private extractFeatureVector(audio: Float32Array): Float32Array | null {
    const frames = this.extractFrames(audio);
    if (frames.length === 0) {
      return null;
    }

    const allMelBands: Float32Array[] = [];
    const allMfcc: Float32Array[] = [];
    let sumRms = 0;
    let sumZcr = 0;
    let sumCentroid = 0;
    let sumSpread = 0;
    let sumRolloff = 0;
    let sumFlatness = 0;
    let sumPitchCorr = 0;
    let sumPitchPos = 0;
    let sumHnr = 0;

    for (const frame of frames) {
      const windowed = this.applyHannWindow(frame);

      let rms = 0;
      let zcr = 0;
      for (let i = 0; i < windowed.length; i += 1) {
        const s = windowed[i]!;
        rms += s * s;
        if (i > 0 && ((windowed[i - 1]! >= 0 && s < 0) || (windowed[i - 1]! < 0 && s >= 0))) {
          zcr += 1;
        }
      }
      rms = Math.sqrt(rms / windowed.length);
      if (!Number.isFinite(rms) || rms < 1e-6) {
        continue;
      }
      zcr /= Math.max(1, windowed.length - 1);

      const magnitudes = this.computeFFTMagnitudes(windowed);
      const melBands = this.melFilterbank(magnitudes);
      const mfcc = this.dctType2(melBands);

      const { centroid, spread, rolloff, flatness } = this.spectralShape(magnitudes);
      const { pitchCorrelation, pitchPosition, hnr } = this.estimatePitchFeatures(windowed);

      allMelBands.push(melBands);
      allMfcc.push(mfcc);
      sumRms += rms;
      sumZcr += zcr;
      sumCentroid += centroid;
      sumSpread += spread;
      sumRolloff += rolloff;
      sumFlatness += flatness;
      sumPitchCorr += pitchCorrelation;
      sumPitchPos += pitchPosition;
      sumHnr += hnr;
    }

    const nFrames = allMelBands.length;
    if (nFrames === 0) {
      return null;
    }

    const avgMfcc = new Float32Array(NUM_MFCC);
    for (const m of allMfcc) {
      for (let i = 0; i < NUM_MFCC; i += 1) {
        avgMfcc[i] += m[i]!;
      }
    }
    for (let i = 0; i < NUM_MFCC; i += 1) {
      avgMfcc[i] /= nFrames;
    }

    const deltaMfcc = new Float32Array(NUM_MFCC);
    if (allMfcc.length >= 2) {
      for (let i = 0; i < NUM_MFCC; i += 1) {
        deltaMfcc[i] = allMfcc[allMfcc.length - 1]![i]! - allMfcc[0]![i]!;
      }
    }

    const avgMelBands = new Float32Array(NUM_MEL_BANDS);
    for (const b of allMelBands) {
      for (let i = 0; i < NUM_MEL_BANDS; i += 1) {
        avgMelBands[i] += b[i]!;
      }
    }
    for (let i = 0; i < NUM_MEL_BANDS; i += 1) {
      avgMelBands[i] /= nFrames;
    }

    const inv = 1 / nFrames;
    const feature = new Float32Array(NUM_MFCC + NUM_MFCC + NUM_MEL_BANDS + 9);
    let idx = 0;

    for (let i = 0; i < NUM_MFCC; i += 1) feature[idx++] = avgMfcc[i]!;
    for (let i = 0; i < NUM_MFCC; i += 1) feature[idx++] = deltaMfcc[i]!;
    for (let i = 0; i < NUM_MEL_BANDS; i += 1) feature[idx++] = avgMelBands[i]!;

    feature[idx++] = sumRms * inv;
    feature[idx++] = sumZcr * inv;
    feature[idx++] = sumCentroid * inv;
    feature[idx++] = sumSpread * inv;
    feature[idx++] = sumRolloff * inv;
    feature[idx++] = sumFlatness * inv;
    feature[idx++] = sumPitchCorr * inv;
    feature[idx++] = sumPitchPos * inv;
    feature[idx++] = sumHnr * inv;

    this.normalizeInPlace(feature);
    return feature;
  }

  // ─── Frame extraction ────────────────────────────────────────────────

  private extractFrames(audio: Float32Array): Float32Array[] {
    if (audio.length < MIN_AUDIO_SAMPLES) {
      return [];
    }

    const hopSize = FEATURE_FRAME_SIZE / 2;
    const frames: Float32Array[] = [];
    let start = 0;

    while (start + FEATURE_FRAME_SIZE <= audio.length) {
      frames.push(audio.subarray(start, start + FEATURE_FRAME_SIZE));
      start += hopSize;
    }

    if (frames.length === 0 && audio.length >= MIN_AUDIO_SAMPLES) {
      const padded = new Float32Array(FEATURE_FRAME_SIZE);
      padded.set(audio.subarray(0, Math.min(audio.length, FEATURE_FRAME_SIZE)));
      frames.push(padded);
    }

    return frames;
  }

  private applyHannWindow(frame: Float32Array): Float32Array {
    const n = frame.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      out[i] = frame[i]! * w;
    }
    return out;
  }

  // ─── FFT magnitudes (radix-2 Cooley–Tukey) ─────────────────────────

  private computeFFTMagnitudes(frame: Float32Array): Float32Array {
    const n = frame.length;
    const numBins = Math.floor(n / 2) + 1;

    const real = new Float32Array(n);
    const imag = new Float32Array(n);

    // Bit-reversal permutation
    for (let i = 0; i < n; i += 1) {
      let rev = 0;
      let bits = i;
      for (let b = 1; b < n; b <<= 1) {
        rev = (rev << 1) | (bits & 1);
        bits >>= 1;
      }
      real[rev] = frame[i]!;
    }

    // Cooley–Tukey butterfly stages
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = (2 * Math.PI) / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j += 1) {
          const angle = -step * j;
          const tRe = Math.cos(angle) * real[i + j + half]! - Math.sin(angle) * imag[i + j + half]!;
          const tIm = Math.cos(angle) * imag[i + j + half]! + Math.sin(angle) * real[i + j + half]!;
          real[i + j + half] = real[i + j]! - tRe;
          imag[i + j + half] = imag[i + j]! - tIm;
          real[i + j] = real[i + j]! + tRe;
          imag[i + j] = imag[i + j]! + tIm;
        }
      }
    }

    const magnitudes = new Float32Array(numBins);
    for (let k = 0; k < numBins; k += 1) {
      magnitudes[k] = Math.sqrt(real[k]! * real[k]! + imag[k]! * imag[k]!);
    }
    return magnitudes;
  }

  // ─── Mel filterbank ──────────────────────────────────────────────────

  private hzToMel(hz: number): number {
    return 2595 * Math.log10(1 + hz / 700);
  }

  private melToHz(mel: number): number {
    return 700 * (10 ** (mel / 2595) - 1);
  }

  private melFilterbank(magnitudes: Float32Array): Float32Array {
    const numBins = magnitudes.length;
    const nyquist = ASSUMED_SAMPLE_RATE / 2;
    const melLow = this.hzToMel(80);
    const melHigh = this.hzToMel(nyquist);

    const melPoints = new Float32Array(NUM_MEL_BANDS + 2);
    for (let i = 0; i < NUM_MEL_BANDS + 2; i += 1) {
      melPoints[i] = melLow + ((melHigh - melLow) * i) / (NUM_MEL_BANDS + 1);
    }

    const fftFreqs = new Float32Array(NUM_MEL_BANDS + 2);
    for (let i = 0; i < NUM_MEL_BANDS + 2; i += 1) {
      fftFreqs[i] = Math.round((this.melToHz(melPoints[i]!) / nyquist) * (numBins - 1));
    }

    const bands = new Float32Array(NUM_MEL_BANDS);
    for (let m = 0; m < NUM_MEL_BANDS; m += 1) {
      const left = fftFreqs[m]!;
      const center = fftFreqs[m + 1]!;
      const right = fftFreqs[m + 2]!;
      let sum = 0;

      for (let k = Math.floor(left); k <= Math.min(Math.ceil(right), numBins - 1); k += 1) {
        let weight = 0;
        if (k >= left && k <= center && center > left) {
          weight = (k - left) / (center - left);
        } else if (k > center && k <= right && right > center) {
          weight = (right - k) / (right - center);
        }
        sum += weight * (magnitudes[k] ?? 0);
      }

      bands[m] = Math.log(Math.max(sum, 1e-10));
    }

    return bands;
  }

  // ─── DCT type-II (for MFCC) ──────────────────────────────────────────

  private dctType2(logMelBands: Float32Array): Float32Array {
    const n = logMelBands.length;
    const mfcc = new Float32Array(NUM_MFCC);

    for (let k = 0; k < NUM_MFCC; k += 1) {
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        sum += logMelBands[i]! * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
      }
      mfcc[k] = sum;
    }

    return mfcc;
  }

  // ─── Spectral shape descriptors ──────────────────────────────────────

  private spectralShape(magnitudes: Float32Array): {
    centroid: number;
    spread: number;
    rolloff: number;
    flatness: number;
  } {
    const n = magnitudes.length;
    let total = 0;
    let weighted = 0;
    let logSum = 0;
    let logCount = 0;

    for (let i = 0; i < n; i += 1) {
      const m = magnitudes[i]!;
      total += m;
      weighted += i * m;
      if (m > 1e-10) {
        logSum += Math.log(m);
        logCount += 1;
      }
    }

    if (total <= 1e-9) {
      return { centroid: 0, spread: 0, rolloff: 0, flatness: 0 };
    }

    const centroid = weighted / total;
    const normalizedCentroid = centroid / Math.max(1, n - 1);

    let spreadSum = 0;
    for (let i = 0; i < n; i += 1) {
      const diff = i - centroid;
      spreadSum += diff * diff * magnitudes[i]!;
    }
    const spread = Math.sqrt(spreadSum / total) / Math.max(1, n - 1);

    let cumulative = 0;
    const rolloffThreshold = 0.85 * total;
    let rolloffBin = n - 1;
    for (let i = 0; i < n; i += 1) {
      cumulative += magnitudes[i]!;
      if (cumulative >= rolloffThreshold) {
        rolloffBin = i;
        break;
      }
    }
    const rolloff = rolloffBin / Math.max(1, n - 1);

    const geometricMean = logCount > 0 ? Math.exp(logSum / logCount) : 0;
    const arithmeticMean = total / Math.max(1, n);
    const flatness = arithmeticMean > 1e-9 ? geometricMean / arithmeticMean : 0;

    return {
      centroid: normalizedCentroid,
      spread,
      rolloff,
      flatness: Math.min(1, Math.max(0, flatness)),
    };
  }

  // ─── Pitch estimation (autocorrelation) ──────────────────────────────

  private estimatePitchFeatures(frame: Float32Array): {
    pitchCorrelation: number;
    pitchPosition: number;
    hnr: number;
  } {
    const n = frame.length;
    if (n < 400) {
      return { pitchCorrelation: 0, pitchPosition: 0, hnr: 0 };
    }

    // Downsample 2× for faster autocorrelation (8kHz still captures up to 4kHz)
    const ds = 2;
    const dn = Math.floor(n / ds);
    const dsFrame = new Float32Array(dn);
    for (let i = 0; i < dn; i += 1) {
      dsFrame[i] = frame[i * ds]!;
    }

    let energy = 0;
    for (let i = 0; i < dn; i += 1) {
      energy += dsFrame[i]! * dsFrame[i]!;
    }
    if (energy < 1e-9) {
      return { pitchCorrelation: 0, pitchPosition: 0, hnr: 0 };
    }

    const dsRate = ASSUMED_SAMPLE_RATE / ds;
    const lagMin = Math.max(8, Math.floor(dsRate / 500));
    const lagMax = Math.min(Math.floor(dsRate / 60), dn - 2);
    let bestCorr = 0;
    let bestLag = lagMin;

    for (let lag = lagMin; lag <= lagMax; lag += 1) {
      let corr = 0;
      for (let i = 0; i < dn - lag; i += 1) {
        corr += dsFrame[i]! * dsFrame[i + lag]!;
      }
      const normalized = corr / energy;
      if (normalized > bestCorr) {
        bestCorr = normalized;
        bestLag = lag;
      }
    }

    const pitchCorrelation = Math.max(0, Math.min(1, bestCorr));
    const pitchPosition = lagMax > lagMin ? (bestLag - lagMin) / (lagMax - lagMin) : 0;

    const hnr = pitchCorrelation > 0.01 ? 10 * Math.log10(pitchCorrelation / (1 - pitchCorrelation + 1e-9)) : 0;
    const normalizedHnr = Math.max(0, Math.min(1, (hnr + 10) / 40));

    return {
      pitchCorrelation,
      pitchPosition: Math.max(0, Math.min(1, pitchPosition)),
      hnr: normalizedHnr,
    };
  }

  // ─── Utilities ───────────────────────────────────────────────────────

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i += 1) {
      const av = a[i]!;
      const bv = b[i]!;
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom <= 1e-9) {
      return 0;
    }
    return dot / denom;
  }

  private normalizeInPlace(vector: Float32Array): void {
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) {
      norm += vector[i]! * vector[i]!;
    }
    const denom = Math.sqrt(norm);
    if (denom <= 1e-9) {
      return;
    }
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] /= denom;
    }
  }
}
