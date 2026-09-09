/**
 * TASK-934 — `AiModelAsrProfile`: the typed shape of `AiModel._metadata.asr`.
 *
 * R-3 ("best practices for fine-tuned models"): the parameters a fine-tune was
 * VALIDATED with belong to the row that owns the weights, not to whichever agent
 * happens to bind it. TASK-880 put the first two — the decode window and the
 * partial tail — on the row; this widens the same slot into a full decode
 * profile so a quantisation swap (TASK-930 moved the seeded agent's primary from
 * the f16 row to the q8_0 row) can never silently change decode geometry again.
 *
 * The row is admin-editable JSON, so this module is the boundary between "what an
 * admin typed" and "what `buildResolvedAsrSpec` may act on". Every member is a
 * TUNING knob, and tuning is `open-to-default` (rule 09 §Configuration Tiers): an
 * unknown key or an out-of-range value is DROPPED and NAMED in `rejected` — never
 * fail-closed (that posture is reserved for SELECTION), and never forwarded to a
 * runtime whose mirror is `extra='forbid'` and whose adapters call `float()`.
 *
 * Precedence is OD-3: agent parameters → this profile → the engine default. The
 * profile never wins over a tenant-authored agent; it fills what the agent left
 * unsaid, which is what makes it a per-model DEFAULT rather than a per-model
 * override.
 */

/** The decode knobs a fine-tune may recommend. Every member optional; absent ⇒ no opinion. */
export interface AiModelAsrProfileDecoding {
  /** Beam width. `InferenceConfig.beam_size`. */
  beamSize?: number;
  /** Sampling temperature. `InferenceConfig.temperature` (wrapped into the engine's list). */
  temperature?: number;
  /** Above this no-speech probability a segment is discarded. `InferenceConfig.no_speech_threshold`. */
  noSpeechThreshold?: number;
  /** Gzip compression ratio above which a decode is treated as looping. `InferenceConfig.compression_ratio_threshold`. */
  compressionRatioThreshold?: number;
  /** Average log-probability floor for accepting a decode. `InferenceConfig.logprob_threshold`. */
  logprobThreshold?: number;
  /** Feed the previous window's tokens as decoder context. `InferenceConfig.condition_on_prev_tokens`. */
  conditionOnPrevTokens?: boolean;
  /** N-gram repetition block. `InferenceConfig.no_repeat_ngram_size`. */
  noRepeatNgramSize?: number;
  /** How many words of previous text ride as decoder context. `InferenceConfig.prev_text_context_words`. */
  prevTextContextWords?: number;
  /** Terms biased into the decode. Folded into `instruction.hotwords` when the agent names none. */
  hotwords?: string[];
}

/**
 * `AiModel._metadata.asr` — the decode profile that travels with a registered model.
 *
 * `maxDecodeWindowSec` / `partialWindowSec` predate this ticket (TASK-880) and keep their
 * meaning; `decoding` and `initialPrompt` are TASK-934's additions (OD-4, OD-11).
 */
export interface AiModelAsrProfile {
  /** Longest audio fed to the engine in ONE decode, seconds. */
  maxDecodeWindowSec?: number;
  /** Tail window of the live utterance decoded for PARTIALs, seconds. */
  partialWindowSec?: number;
  /** Recommended decode knobs for this fine-tune. */
  decoding?: AiModelAsrProfileDecoding;
  /**
   * OD-11 — the priming prompt this fine-tune was measured with. A prompt is a
   * per-fine-tune property (on the ml-en set it costs ≈0.06 CER, on English long
   * utterances it helps), so it belongs beside the weights, not in one agent-wide truth.
   */
  initialPrompt?: string;
}

/** Inclusive `[min, max]` bounds, published so an admin UI and the API validator share ONE table. */
export interface AiModelAsrProfileRange {
  readonly min: number;
  readonly max: number;
  /** Whole numbers only — the engine field is an `int`, so `2.5` is a typo, not a value. */
  readonly integer?: boolean;
}

/** The two window members' ranges. */
export const AI_MODEL_ASR_PROFILE_WINDOW_RANGES: Readonly<Record<'maxDecodeWindowSec' | 'partialWindowSec', AiModelAsrProfileRange>> =
  Object.freeze({
    maxDecodeWindowSec: Object.freeze({ min: 1, max: 30 }),
    partialWindowSec: Object.freeze({ min: 1, max: 30 }),
  });

/**
 * The numeric decode knobs' ranges. Mirrored by `SPEECH_TO_TEXT_PARAMETERS.decoding`
 * in `@arcaai/workflow-contract` — the agent level and the model level accept the SAME
 * range for the same knob, because they feed the same engine field.
 */
export const AI_MODEL_ASR_PROFILE_DECODING_RANGES: Readonly<Record<string, AiModelAsrProfileRange>> = Object.freeze({
  beamSize: Object.freeze({ min: 1, max: 10, integer: true }),
  temperature: Object.freeze({ min: 0, max: 1 }),
  noSpeechThreshold: Object.freeze({ min: 0, max: 1 }),
  compressionRatioThreshold: Object.freeze({ min: 1, max: 10 }),
  logprobThreshold: Object.freeze({ min: -10, max: 0 }),
  noRepeatNgramSize: Object.freeze({ min: 0, max: 10, integer: true }),
  prevTextContextWords: Object.freeze({ min: 0, max: 200, integer: true }),
});

/** Max entries in `decoding.hotwords`; max characters in `initialPrompt`. */
export const AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS = 64;
export const AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH = 1000;

export interface ParsedAiModelAsrProfile {
  /** Only the members that survived. Never carries `undefined` members or an empty `decoding`. */
  profile: AiModelAsrProfile;
  /**
   * Dotted paths of everything dropped — an unknown key, a wrong type, or a value
   * outside its range. The resolver logs this at WARN: a silently ignored profile is
   * exactly the failure mode TASK-934 §2.2 spent a day chasing.
   */
  rejected: string[];
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);

function inRange(value: unknown, range: AiModelAsrProfileRange): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.integer && !Number.isInteger(value)) return false;
  return value >= range.min && value <= range.max;
}

function isHotwordList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS &&
    value.every((word) => typeof word === 'string' && word.length > 0)
  );
}

function isInitialPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH;
}

/** `decoding`, parsed. Returns `undefined` when nothing survived, so the caller omits the key. */
function parseDecoding(raw: unknown, prefix: string, rejected: string[]): AiModelAsrProfileDecoding | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRec(raw)) {
    rejected.push(prefix.slice(0, -1));
    return undefined;
  }
  const out: AiModelAsrProfileDecoding = {};
  for (const [key, range] of Object.entries(AI_MODEL_ASR_PROFILE_DECODING_RANGES)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (inRange(value, range)) (out as Rec)[key] = value;
    else rejected.push(`${prefix}${key}`);
  }
  if (raw.conditionOnPrevTokens !== undefined) {
    if (typeof raw.conditionOnPrevTokens === 'boolean') out.conditionOnPrevTokens = raw.conditionOnPrevTokens;
    else rejected.push(`${prefix}conditionOnPrevTokens`);
  }
  if (raw.hotwords !== undefined) {
    if (isHotwordList(raw.hotwords)) out.hotwords = [...raw.hotwords];
    else rejected.push(`${prefix}hotwords`);
  }
  const known = new Set([...Object.keys(AI_MODEL_ASR_PROFILE_DECODING_RANGES), 'conditionOnPrevTokens', 'hotwords']);
  for (const key of Object.keys(raw)) if (!known.has(key)) rejected.push(`${prefix}${key}`);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read `AiModel._metadata.asr` into the profile the resolver may act on.
 *
 * Visit order is DECLARED members first (in declaration order), then unknown keys in
 * the order the row wrote them — so `rejected` is stable across two rows that carry the
 * same content in a different JSON key order, and a warn line does not churn.
 */
export function parseAiModelAsrProfile(raw: unknown): ParsedAiModelAsrProfile {
  const rejected: string[] = [];
  const profile: AiModelAsrProfile = {};
  if (!isRec(raw)) return { profile, rejected };

  for (const [key, range] of Object.entries(AI_MODEL_ASR_PROFILE_WINDOW_RANGES)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (inRange(value, range)) (profile as Rec)[key] = value;
    else rejected.push(key);
  }
  const decoding = parseDecoding(raw.decoding, 'decoding.', rejected);
  if (decoding) profile.decoding = decoding;
  if (raw.initialPrompt !== undefined) {
    if (isInitialPrompt(raw.initialPrompt)) profile.initialPrompt = raw.initialPrompt;
    else rejected.push('initialPrompt');
  }

  const known = new Set([...Object.keys(AI_MODEL_ASR_PROFILE_WINDOW_RANGES), 'decoding', 'initialPrompt']);
  for (const key of Object.keys(raw)) if (!known.has(key)) rejected.push(key);
  return { profile, rejected };
}
