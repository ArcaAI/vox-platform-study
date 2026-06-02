/**
 * Voice-embedding math + provider-selection utilities (TASK-329 P4).
 *
 * Pure, deterministic helpers shared by the LOCAL in-browser voice-embedding
 * provider: cosine similarity for the "quick test" speaker match, centroid
 * pooling of multiple enrollment samples, and the local/backend provider
 * resolver. No ONNX, no network, no DOM — fixture vectors only.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOICE_MATCH_THRESHOLD,
  VOICE_ENROLLMENT_PROVIDERS,
  DEFAULT_VOICE_ENROLLMENT_PROVIDER,
  cosineSimilarity,
  l2Normalize,
  averageEmbeddings,
  bestMatch,
  isVoiceEnrollmentProvider,
  resolveVoiceEnrollmentProvider,
  type VoiceEnrollmentProvider,
} from '../voiceEmbedding';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns 1 for parallel (scaled) vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 10);
  });

  it('matches a known hand-computed value', () => {
    // a·b = 1*4 + 2*5 + 3*6 = 32 ; |a| = sqrt(14) ; |b| = sqrt(77)
    // cos = 32 / (sqrt(14)*sqrt(77)) = 32 / sqrt(1078) ≈ 0.974631846
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.974631846, 8);
  });

  it('accepts Float32Array (the transformers.js output type)', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const b = new Float32Array([0.1, 0.2, 0.3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('returns 0 when either vector is all-zero (no NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe('l2Normalize', () => {
  it('produces a unit-length vector', () => {
    const out = l2Normalize([3, 4]);
    expect(Math.hypot(...out)).toBeCloseTo(1, 10);
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
  });

  it('returns zeros for a zero vector (no division by zero)', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('averageEmbeddings', () => {
  it('returns the L2-normalized centroid of multiple sample embeddings', () => {
    // mean of [1,0,0] and [0,1,0] is [0.5,0.5,0] → normalized ≈ [0.7071,0.7071,0]
    const out = averageEmbeddings([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 8);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 8);
    expect(out[2]).toBeCloseTo(0, 8);
    expect(Math.hypot(...out)).toBeCloseTo(1, 8);
  });

  it('returns a unit-normalized copy for a single embedding', () => {
    const out = averageEmbeddings([[3, 4]]);
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
  });

  it('throws on an empty list', () => {
    expect(() => averageEmbeddings([])).toThrow();
  });

  it('throws on dimension mismatch between samples', () => {
    expect(() =>
      averageEmbeddings([
        [1, 0, 0],
        [1, 0],
      ]),
    ).toThrow();
  });
});

describe('bestMatch (quick-test cosine comparison)', () => {
  const enrolled = [
    { profileId: 'p-speaker-1', embedding: [1, 0, 0] },
    { profileId: 'p-speaker-2', embedding: [0, 1, 0] },
  ];

  it('returns null when there are no enrolled embeddings', () => {
    expect(bestMatch([1, 0, 0], [])).toBeNull();
  });

  it('selects the closest enrolled profile and reports a match above threshold', () => {
    const res = bestMatch([0.95, 0.05, 0], enrolled, 0.85);
    expect(res).not.toBeNull();
    expect(res!.profileId).toBe('p-speaker-1');
    expect(res!.score).toBeGreaterThan(0.85);
    expect(res!.isMatch).toBe(true);
    expect(res!.threshold).toBe(0.85);
  });

  it('reports no-match when the best score is below threshold', () => {
    // candidate dominated by an unseen 3rd axis → low similarity to both
    const res = bestMatch([0.1, 0.1, 1], enrolled, 0.85);
    expect(res).not.toBeNull();
    expect(res!.isMatch).toBe(false);
    expect(res!.score).toBeLessThan(0.85);
  });

  it('uses DEFAULT_VOICE_MATCH_THRESHOLD when no threshold is given', () => {
    const res = bestMatch([0, 1, 0], enrolled);
    expect(res!.profileId).toBe('p-speaker-2');
    expect(res!.threshold).toBe(DEFAULT_VOICE_MATCH_THRESHOLD);
  });
});

describe('provider selection', () => {
  it('exposes exactly the {backend, local} providers in stable order', () => {
    expect(VOICE_ENROLLMENT_PROVIDERS).toEqual(['backend', 'local']);
  });

  it('defaults to the backend provider', () => {
    expect(DEFAULT_VOICE_ENROLLMENT_PROVIDER).toBe('backend');
  });

  it('isVoiceEnrollmentProvider narrows valid values', () => {
    expect(isVoiceEnrollmentProvider('local')).toBe(true);
    expect(isVoiceEnrollmentProvider('backend')).toBe(true);
    expect(isVoiceEnrollmentProvider('remote')).toBe(false);
    expect(isVoiceEnrollmentProvider(undefined)).toBe(false);
  });

  it('honors a local preference only when local extraction is supported', () => {
    expect(resolveVoiceEnrollmentProvider({ preferred: 'local', localSupported: true })).toBe('local');
    expect(resolveVoiceEnrollmentProvider({ preferred: 'local', localSupported: false })).toBe('backend');
  });

  it('keeps the backend preference regardless of local support', () => {
    expect(resolveVoiceEnrollmentProvider({ preferred: 'backend', localSupported: true })).toBe('backend');
  });

  it('falls back to the default for unknown/empty preferences', () => {
    const fallback: VoiceEnrollmentProvider = DEFAULT_VOICE_ENROLLMENT_PROVIDER;
    expect(resolveVoiceEnrollmentProvider({ preferred: null, localSupported: true })).toBe(fallback);
    expect(resolveVoiceEnrollmentProvider({ preferred: 'nonsense', localSupported: true })).toBe(fallback);
  });
});
