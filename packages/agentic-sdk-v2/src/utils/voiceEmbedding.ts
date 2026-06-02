/**
 * @arcaai/vox - Voice-embedding math + provider selection (TASK-329 P4)
 *
 * Pure, dependency-free helpers shared by the LOCAL in-browser voice-embedding
 * provider. They are deliberately framework/DOM/ONNX-agnostic so they unit-test
 * deterministically on fixture vectors:
 *
 *   - `cosineSimilarity` / `bestMatch` power the "quick test" speaker match
 *     (cosine similarity of a freshly-extracted embedding against the enrolled
 *     embedding(s), exactly like the WavLM speaker-verification recipe).
 *   - `averageEmbeddings` pools multiple enrollment samples into one centroid.
 *   - `resolveVoiceEnrollmentProvider` lets the UI pick LOCAL vs BACKEND while
 *     failing safe to the backend when in-browser extraction is unsupported.
 */

/**
 * Default cosine-similarity threshold above which two embeddings are treated as
 * the same speaker. WavLM `*-sv` embeddings put same-speaker pairs ≈0.95+ and
 * different speakers ≈0.6, and the upstream model card suggests ~0.86; 0.85 is
 * a slightly permissive, dataset-independent default for the playground.
 */
export const DEFAULT_VOICE_MATCH_THRESHOLD = 0.85;

/** The voice-enrollment providers the UI can choose between (stable order). */
export const VOICE_ENROLLMENT_PROVIDERS = ['backend', 'local'] as const;

export type VoiceEnrollmentProvider = (typeof VOICE_ENROLLMENT_PROVIDERS)[number];

/** Default provider: server-side extraction (unchanged, always available). */
export const DEFAULT_VOICE_ENROLLMENT_PROVIDER: VoiceEnrollmentProvider = 'backend';

function toFloatArray(v: ArrayLike<number>): number[] {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  return out;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 (not NaN) when either vector has zero
 * magnitude. Throws when the two vectors have different dimensions.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Return a unit-length copy of `v`. A zero vector is returned unchanged (zeros). */
export function l2Normalize(v: ArrayLike<number>): number[] {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  if (mag === 0) return toFloatArray(v);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
  return out;
}

/**
 * L2-normalized centroid (mean) of one or more equal-length embeddings. Pooling
 * multiple enrollment samples into a single robust speaker embedding.
 */
export function averageEmbeddings(vectors: ReadonlyArray<ArrayLike<number>>): number[] {
  if (vectors.length === 0) {
    throw new Error('averageEmbeddings: at least one embedding is required');
  }
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    if (vec.length !== dim) {
      throw new Error(`averageEmbeddings: dimension mismatch (${vec.length} vs ${dim})`);
    }
    for (let i = 0; i < dim; i++) sum[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return l2Normalize(sum);
}

export interface EnrolledEmbeddingRef {
  profileId: string;
  embedding: number[];
  label?: string | null;
}

export interface VoiceMatchResult {
  /** Enrolled profile whose embedding is most similar to the candidate. */
  profileId: string;
  /** Cosine similarity in [-1, 1] of the best match. */
  score: number;
  /** True when `score >= threshold`. */
  isMatch: boolean;
  /** Threshold used to decide the match. */
  threshold: number;
}

/**
 * Compare a candidate embedding against every enrolled embedding and return the
 * single best match (highest cosine similarity), or `null` when nothing is
 * enrolled. This is the core of the "quick test".
 */
export function bestMatch(
  candidate: ArrayLike<number>,
  enrolled: ReadonlyArray<EnrolledEmbeddingRef>,
  threshold: number = DEFAULT_VOICE_MATCH_THRESHOLD,
): VoiceMatchResult | null {
  if (enrolled.length === 0) return null;
  let bestProfileId = enrolled[0].profileId;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const ref of enrolled) {
    const score = cosineSimilarity(candidate, ref.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestProfileId = ref.profileId;
    }
  }
  return {
    profileId: bestProfileId,
    score: bestScore,
    isMatch: bestScore >= threshold,
    threshold,
  };
}

export function isVoiceEnrollmentProvider(x: unknown): x is VoiceEnrollmentProvider {
  return typeof x === 'string' && (VOICE_ENROLLMENT_PROVIDERS as readonly string[]).includes(x);
}

/**
 * Resolve the effective provider from a (possibly invalid) UI preference. A
 * `local` preference is only honored when in-browser extraction is supported;
 * everything else fails safe to {@link DEFAULT_VOICE_ENROLLMENT_PROVIDER}.
 */
export function resolveVoiceEnrollmentProvider(opts: {
  preferred?: string | null;
  localSupported: boolean;
}): VoiceEnrollmentProvider {
  const { preferred, localSupported } = opts;
  if (preferred === 'local') {
    return localSupported ? 'local' : 'backend';
  }
  if (preferred === 'backend') {
    return 'backend';
  }
  return DEFAULT_VOICE_ENROLLMENT_PROVIDER;
}
