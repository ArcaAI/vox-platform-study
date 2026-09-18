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

/**
 * The decode knobs a fine-tune may recommend. Every member optional; absent ⇒ no opinion.
 *
 * A `type`, not an `interface`, and deliberately so: this and {@link AiModelAsrProfile}
 * are the SHAPE OF STORED JSON (`AiModel._metadata.asr`). TypeScript gives a type alias an
 * implicit index signature but withholds one from an interface, so an interface here is
 * not assignable to Prisma's `InputJsonValue` and every seed row writing the column fails
 * to compile. Keep both as type aliases.
 */
export type AiModelAsrProfileDecoding = {
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
  /**
   * TASK-985 (QW-9) — whisper.cpp's `entropy_thold`: the token-distribution entropy
   * BELOW which a decode is treated as degenerate.
   *
   * This is deliberately NOT an alias of {@link compressionRatioThreshold}. The two
   * share the default 2.4 and pywhispercpp's own schema comment calls one "similar to"
   * the other, but they are different quantities on different scales and compare in
   * OPPOSITE directions: OpenAI's gate rejects text whose gzip ratio is ABOVE the
   * threshold, whisper.cpp's rejects a distribution whose entropy is BELOW it. Aliasing
   * them would silently mean the opposite thing, so they are two keys and each engine
   * reports the one it cannot honour (see `AsrSpecDecodingSource`).
   */
  entropyThreshold?: number;
  /** whisper.cpp `single_segment` — force one segment out of one decode. Upstream's streaming advice. */
  singleSegment?: boolean;
  /** whisper.cpp `suppress_blank`. Engine default `true`; stated so it cannot drift. */
  suppressBlank?: boolean;
  /** whisper.cpp `suppress_nst` — suppress non-speech tokens (`[music]`, `(laughter)`). Engine default `false`. */
  suppressNonSpeechTokens?: boolean;
  /** whisper.cpp `max_tokens` — bound a runaway loop AT the decoder. `0` = no limit. */
  maxTokens?: number;
  /**
   * whisper.cpp `audio_ctx` — encoder context, `0` = the full trained 1500.
   *
   * Truncating below the trained context is a documented cause of endless repetition, and
   * upstream's own streaming example ships `0`. Treat any reduction as a measured arm.
   */
  audioCtx?: number;
  /**
   * TASK-985 (QW-8) — PER-PASS narrowing of the flat knobs above.
   *
   * A partial re-decodes an utterance that is still open, ~3x a second; a final decodes
   * it once, for the record. They want different decodes — a partial wants cheap,
   * bounded and single-segment, a final wants the full one — and the runtime already
   * branches on `utterance.is_final`, so the profile says so rather than the code.
   *
   * Precedence, stated once: **pass block → flat block → the engine dataclass default.**
   * Absent means "no opinion", never "off".
   */
  partial?: AiModelAsrProfileDecodingPass;
  final?: AiModelAsrProfileDecodingPass;
  /**
   * TASK-946 (OD-1), the TASK-937 R-4 switch — may this model's engine append
   * {@link hotwords} to its decoder prompt?
   *
   * whisper.cpp has no hotword API, so the only way to bias it toward a term is to list
   * the terms in the `initial_prompt`. On the seeded `ml-en` fine-tune that append is
   * what collapses an English consultation into Malayalam script: measured offline on
   * the owner's recording (7 s spans, `language=en`, temperature 0) the same audio
   * decodes 100 % Latin with no prompt and **2 %** Latin with the priming prompt, the
   * agent prompt and these terms together. TASK-935 removed the append after the same
   * failure; TASK-938 restored it globally; this makes it a property of the ROW, which
   * is where "this fine-tune tolerates a vocabulary prompt" actually belongs.
   *
   * ABSENT is the engine default, and for whisper.cpp that default is OFF. The terms
   * still reach the LEXICON correction stage either way — dropping them from the prompt
   * costs bias, never vocabulary.
   *
   * TASK-985 (owner decision OD-E) — this is a ONE-TIER knob: the MODEL ROW and nothing
   * else. It is a fact about the weights ("this fine-tune tolerates a vocabulary
   * prompt"), and an agent may swap `modelId` underneath a switch it set, silently
   * re-enabling the collapse on weights nobody measured with it. The exception to
   * TASK-934 OD-4(a)'s "agent → model profile" precedence is enforced MECHANICALLY —
   * `buildResolvedAsrSpec` reads no agent-tier value, so `sources.hotwordsInPrompt` can
   * only ever be `'model'` — because a rule enforced by a deleted code path cannot drift
   * and a rule enforced by a comment will.
   */
  hotwordsInPrompt?: boolean;
}

/**
 * TASK-985 (QW-8) — the subset of {@link AiModelAsrProfileDecoding} a row may narrow
 * PER DECODE PASS (`partial` = the in-flight re-decode, `final` = the committing one).
 *
 * Every member is optional and means the same thing it does on the flat block; the only
 * difference is scope. Ranges are shared with the flat block (one engine field, one
 * accepted range), which is why they live in one table.
 */
export type AiModelAsrProfileDecodingPass = {
  beamSize?: number;
  temperature?: number;
  logprobThreshold?: number;
  entropyThreshold?: number;
  noSpeechThreshold?: number;
  singleSegment?: boolean;
  suppressBlank?: boolean;
  suppressNonSpeechTokens?: boolean;
  maxTokens?: number;
  audioCtx?: number;
}

/**
 * `AiModel._metadata.asr` — the decode profile that travels with a registered model.
 *
 * `maxDecodeWindowSec` / `partialWindowSec` predate this ticket (TASK-880) and keep their
 * meaning; `decoding` and `initialPrompt` are TASK-934's additions (OD-4, OD-11).
 */
export type AiModelAsrProfile = {
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
  // TASK-985 (QW-8/QW-9) — the whisper.cpp decode extras. `entropyThreshold` is a
  // SEPARATE quantity from `compressionRatioThreshold` above (opposite direction,
  // different scale) and must never be aliased onto it. `maxTokens` is bounded by
  // Whisper's own `n_text_ctx / 2` sampling budget; `audioCtx` by the trained 1500-frame
  // encoder context, and `0` means "the full one" for both.
  entropyThreshold: Object.freeze({ min: 0, max: 10 }),
  maxTokens: Object.freeze({ min: 0, max: 224, integer: true }),
  audioCtx: Object.freeze({ min: 0, max: 1500, integer: true }),
});

/**
 * The BOOLEAN decode knobs, listed so the parser, the admin DTO and the agent schema
 * agree on the set without three hand-maintained copies. `hotwordsInPrompt` is NOT here:
 * it is one-tier (OD-E) and parsed on its own.
 */
export const AI_MODEL_ASR_PROFILE_DECODING_FLAGS = Object.freeze([
  'conditionOnPrevTokens',
  'singleSegment',
  'suppressBlank',
  'suppressNonSpeechTokens',
] as const);

/**
 * TASK-985 (QW-8) — the members a `decoding.partial` / `decoding.final` block may carry.
 *
 * A strict SUBSET of the flat block: per-pass narrowing only makes sense for knobs the
 * decoder reads per call. `conditionOnPrevTokens`, `noRepeatNgramSize`,
 * `prevTextContextWords`, `compressionRatioThreshold`, `hotwords` and `hotwordsInPrompt`
 * are deliberately absent — they are session-level or engine-level policy, not a
 * per-call kwarg.
 */
export const AI_MODEL_ASR_PROFILE_PASS_NUMERIC_KEYS = Object.freeze([
  'beamSize',
  'temperature',
  'logprobThreshold',
  'entropyThreshold',
  'noSpeechThreshold',
  'maxTokens',
  'audioCtx',
] as const);
export const AI_MODEL_ASR_PROFILE_PASS_FLAG_KEYS = Object.freeze(['singleSegment', 'suppressBlank', 'suppressNonSpeechTokens'] as const);
/** The two decode passes a profile may narrow. */
export const AI_MODEL_ASR_PROFILE_PASSES = Object.freeze(['partial', 'final'] as const);
export type AiModelAsrProfileDecodingPassName = (typeof AI_MODEL_ASR_PROFILE_PASSES)[number];

/**
 * Max entries in `decoding.hotwords`; max CHARACTERS in `initialPrompt`.
 *
 * TASK-985 (N-4) — the character cap is a publish-time sanity check and NOTHING MORE.
 * It is not a token bound: Whisper's decoder window is `n_text_ctx / 2` = 224 tokens, and
 * 1000 characters of Malayalam is several times that, so on exactly the language that
 * overflows, this number bounds nothing. The real budget is derived from the loaded model
 * (`whisper_n_text_ctx`) and enforced in tokens at serve time, where the carry-forward is
 * evicted from the LEFT so the priming text survives.
 */
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

/** One numeric member, range-gated. Visit order is the caller's, so `rejected` stays stable. */
function takeNumber(raw: Rec, out: Rec, key: string, prefix: string, rejected: string[]): void {
  const value = raw[key];
  if (value === undefined) return;
  const range = AI_MODEL_ASR_PROFILE_DECODING_RANGES[key];
  if (range && inRange(value, range)) out[key] = value;
  else rejected.push(`${prefix}${key}`);
}

/** One boolean member. A truthy STRING is named in `rejected`, never coerced on. */
function takeFlag(raw: Rec, out: Rec, key: string, prefix: string, rejected: string[]): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value === 'boolean') out[key] = value;
  else rejected.push(`${prefix}${key}`);
}

/**
 * TASK-985 (QW-8) — one `decoding.partial` / `decoding.final` block, parsed.
 *
 * Returns `undefined` when nothing survived, so the caller omits the key: an empty
 * block and an absent one are one state, and the wire must have one encoding of it.
 */
function parseDecodingPass(raw: unknown, prefix: string, rejected: string[]): AiModelAsrProfileDecodingPass | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRec(raw)) {
    rejected.push(prefix.slice(0, -1));
    return undefined;
  }
  const out: Rec = {};
  for (const key of AI_MODEL_ASR_PROFILE_PASS_NUMERIC_KEYS) takeNumber(raw, out, key, prefix, rejected);
  for (const key of AI_MODEL_ASR_PROFILE_PASS_FLAG_KEYS) takeFlag(raw, out, key, prefix, rejected);
  const known = new Set<string>([...AI_MODEL_ASR_PROFILE_PASS_NUMERIC_KEYS, ...AI_MODEL_ASR_PROFILE_PASS_FLAG_KEYS]);
  for (const key of Object.keys(raw)) if (!known.has(key)) rejected.push(`${prefix}${key}`);
  return Object.keys(out).length > 0 ? (out as AiModelAsrProfileDecodingPass) : undefined;
}

/** `decoding`, parsed. Returns `undefined` when nothing survived, so the caller omits the key. */
function parseDecoding(raw: unknown, prefix: string, rejected: string[]): AiModelAsrProfileDecoding | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRec(raw)) {
    rejected.push(prefix.slice(0, -1));
    return undefined;
  }
  const out: AiModelAsrProfileDecoding = {};
  for (const key of Object.keys(AI_MODEL_ASR_PROFILE_DECODING_RANGES)) takeNumber(raw, out as Rec, key, prefix, rejected);
  for (const key of AI_MODEL_ASR_PROFILE_DECODING_FLAGS) takeFlag(raw, out as Rec, key, prefix, rejected);
  if (raw.hotwords !== undefined) {
    if (isHotwordList(raw.hotwords)) out.hotwords = [...raw.hotwords];
    else rejected.push(`${prefix}hotwords`);
  }
  // TASK-946 (OD-1) — the per-model hotword-prompt switch. Parsed like
  // `conditionOnPrevTokens`: a boolean or nothing, and anything else is NAMED in
  // `rejected` rather than coerced, because a truthy string here would silently turn
  // on the exact knob this ticket turned off.
  takeFlag(raw, out as Rec, 'hotwordsInPrompt', prefix, rejected);
  // TASK-985 (QW-8) — the two per-pass narrowings, parsed against the same ranges.
  for (const pass of AI_MODEL_ASR_PROFILE_PASSES) {
    const block = parseDecodingPass(raw[pass], `${prefix}${pass}.`, rejected);
    if (block) out[pass] = block;
  }
  const known = new Set<string>([
    ...Object.keys(AI_MODEL_ASR_PROFILE_DECODING_RANGES),
    ...AI_MODEL_ASR_PROFILE_DECODING_FLAGS,
    ...AI_MODEL_ASR_PROFILE_PASSES,
    'hotwords',
    'hotwordsInPrompt',
  ]);
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
