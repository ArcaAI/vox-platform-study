/**
 * TASK-861 — `ResolvedAsrSpec`: the fully resolved speech-to-text runtime
 * contract the gateway hands to `apps/stt` per streaming session and per batch
 * job. It REPLACES `AsrPipeline.configYaml` + the `pipeline_id` the Python
 * service used to look up in Postgres: everything the runtime needs to act is
 * in the payload, so `apps/stt` reads no selection from the database.
 *
 * ONE producer — `buildResolvedAsrSpec()` in `@arcaai/applications`
 * (`services/stt/agent-resolver`), fed by TASK-863's `AgentResolverService`.
 * The Python mirror is `apps/stt/src/stt/pipeline/spec.py`; both sides validate
 * the SAME committed fixture (`tests/contracts/resolved-asr-spec.fixture.json`),
 * which is the cross-language lock.
 *
 * Every model entry is a fully resolved REFERENCE plus what the loader needs
 * (`localPath` first, then `sourceUri` scheme dispatch — the shape
 * `apps/stt`'s `AiModelConfig` already accepts). Credentials never travel here:
 * cloud rows ride alongside as `provider_overrides`, exactly as before.
 *
 * `null` on a tuning field means "the engine default applies" — the spec
 * carries what the agent SAID, normalised; it never restates `apps/stt`'s own
 * dataclass defaults (one source of truth per default).
 */

import type { AiModelAsrProfileDecoding } from './asr-model-profile.js';
import type { ResolvedAgent } from './agent.js';

export const RESOLVED_ASR_SPEC_SCHEMA_VERSION = 1 as const;
export type ResolvedAsrSpecSchemaVersion = typeof RESOLVED_ASR_SPEC_SCHEMA_VERSION;

/**
 * The roles a resolved model plays in the ASR runtime.
 *
 * TASK-877 added `endpointing` — the OPTIONAL self-hosted end-of-utterance
 * detector the semantic endpointer consults. It replaces the free-string platform
 * key `stt.semanticEndpoint.modelId`: an EOU model is now a registry row the agent
 * binds like any other, so an un-published row is the platform's veto and the
 * heuristic core is what an agent gets when it binds nothing.
 */
export const ASR_SPEC_MODEL_ROLES = ['asr', 'vad', 'denoise', 'embedding', 'punctuation', 'endpointing'] as const;
export type AsrSpecModelRole = (typeof ASR_SPEC_MODEL_ROLES)[number];

/**
 * The registry `taskType` each role is loaded under. Mirrors
 * `apps/stt/src/stt/pipeline/dto.py#ModelTaskType` for the four the STT runtime
 * executes itself; `punctuation` is served by `apps/stt`'s punctuation service
 * (Cadence) and `endpointing` by the semantic endpointer — both are referenced by
 * slug only and never enter the STT model cache.
 */
export const ASR_SPEC_ROLE_TASK_TYPE: Readonly<Record<AsrSpecModelRole, string>> = Object.freeze({
  asr: 'AUTOMATIC_SPEECH_RECOGNITION',
  vad: 'VOICE_ACTIVITY_DETECTION',
  denoise: 'AUDIO_TO_AUDIO',
  embedding: 'SPEAKER_EMBEDDING',
  punctuation: 'TOKEN_CLASSIFICATION',
  endpointing: 'TEXT_CLASSIFICATION',
});

/**
 * The `AiModel._metadata` slice that travels with a model on the ASR wire.
 *
 * TASK-880 — `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS` were
 * platform-wide numbers describing ONE engine's decode geometry, applied to every session
 * whatever engine served it. They are model-coupled facts, so they ride the row: the
 * fallback chain now gets its own window rather than inheriting the primary's.
 *
 * OPTIONAL on the wire with the omit-when-absent rule (`_Wire.OPTIONAL_FIELDS` on the
 * Python half): absent means the row declared nothing and the runtime's own default stands.
 */
export interface AsrSpecModelMetadata {
  /** Longest audio fed to the engine in ONE decode, seconds. The ROW alone decides it (TASK-934 OD-3). */
  maxDecodeWindowSec?: number | null;
  /**
   * Tail window of the live utterance decoded for PARTIALs, seconds.
   *
   * TASK-934 (OD-4) — this is the EFFECTIVE value: an agent that sets
   * `parameters.streaming.partialWindowSec` overrides the row here, so the number arrives
   * where the runtime already reads it and no consumer had to learn a second path.
   * `decoding.sources.partialWindowSec` names which tier supplied it.
   */
  partialWindowSec?: number | null;
  /**
   * TASK-934 — the ROW's own decode recommendation, verbatim, EVEN WHERE THE AGENT OVERRODE IT.
   * This is provenance, not instruction: the effective values are in `decoding`, and
   * `decoding.sources` says who won. Carried so one dumped session spec explains itself
   * (§2.2 spent a day on a value that "did not take effect").
   */
  decoding?: AiModelAsrProfileDecoding;
  /** TASK-934 (OD-11) — the priming prompt this fine-tune was measured with, verbatim. */
  initialPrompt?: string;
}

/** One resolved registry row — the fields `apps/stt`'s `AiModelConfig` consumes. */
export interface AsrSpecModel {
  role: AsrSpecModelRole;
  slug: string;
  taskType: string;
  /** `AiModelFormat` value — selects the engine/loader in `apps/stt`. */
  format: string;
  sourceUri: string;
  sourceRevision: string | null;
  /**
   * HIGHEST precedence in `resolve_model_dir`. DERIVED from `AiModel.bucketPrefix`
   * [+ `primaryObject`] since TASK-890 §3.11 — the stored column is gone; the wire
   * value and its precedence are unchanged.
   */
  localPath: string | null;
  checksum: string | null;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
  /** TASK-880 — the row's own decode geometry. OMITTED (never `null`) when it declares none. */
  metadata?: AsrSpecModelMetadata;
}

export interface AsrSpecModels {
  asr: AsrSpecModel;
  vad?: AsrSpecModel;
  denoise?: AsrSpecModel;
  embedding?: AsrSpecModel;
  punctuation?: AsrSpecModel;
  endpointing?: AsrSpecModel;
}

export type AsrSpecDenoiseLevel = 'off' | 'low' | 'medium' | 'high';
export type AsrSpecDiarizationBackend = 'embedding' | 'sortformer';
export type AsrSpecEndpointing = 'fixed' | 'semantic';

/** §3.2 `audioFrontEnd` — replaces `models.vad/denoise/embedding` + `preprocessing.*`. */
export interface AsrSpecAudioFrontEnd {
  vad: {
    enabled: boolean;
    threshold: number | null;
    minSpeechMs: number | null;
    minSilenceMs: number | null;
    /**
     * TASK-880 — padding applied to BOTH ends of a detected segment, ms. Replaces the
     * platform key `stt.vad.speechPadMs`. OPTIONAL on the wire with the omit-when-absent
     * rule (the three siblings above predate it and stay required-but-nullable): absent
     * means the agent said nothing and `VadConfig.padding_ms` stands.
     */
    speechPadMs?: number | null;
  };
  denoise: { enabled: boolean; level: AsrSpecDenoiseLevel };
  diarization: {
    enabled: boolean;
    backend: AsrSpecDiarizationBackend;
    maxSpeakers: number | null;
    /**
     * TASK-887 — the cosine floor at which a segment may be labelled with an ENROLLED
     * voice profile, and the cross-sample consistency floor enrollment itself must
     * clear. Replaces the platform key `stt.voiceProfile.minSimilarity`: how confidently
     * a clinic wants a real name attached to speech is an agent decision, not one number
     * for every tenant on the box.
     *
     * OPTIONAL on the wire with the omit-when-absent rule: absent means the agent said
     * nothing and `DiarizationConfig.match_threshold` — the one source of the engine
     * default — stands.
     */
    matchThreshold?: number | null;
  };
  resample: boolean;
  normalize: boolean;
}

/** TASK-934 — the tier a resolved knob came from (OD-3: agent → model profile → engine default). */
export type AsrSpecDecodingSource = 'agent' | 'model';

/** §3.2 `decoding` — replaces `inference.*`. `languageMode` is resolved per engine by `apps/stt`. */
export interface AsrSpecDecoding {
  languageMode: string | null;
  codeSwitching: boolean;
  wordTimestamps: boolean;
  beamSize: number | null;
  temperature: number | null;
  vadFilter: boolean;
  /**
   * TASK-877 / owner decision #9 — per-agent batch chunking, OPTIONAL on the wire.
   * ABSENT (the key omitted, never `null`) means the agent expressed no opinion and
   * the batch path keeps the platform `stt.transcription.{chunkLengthS,strideLengthS}`
   * values. Omission rather than `null` is what makes the field safe to add on either
   * side first: `apps/stt`'s mirror is `extra='forbid'`, so an unknown key is a
   * contract drift, and a `null` the mirror has not learned yet would be one.
   */
  chunkLengthSec?: number | null;
  /** `[left, right]` context seconds around each chunk. Same optionality as `chunkLengthSec`. */
  strideLengthSec?: readonly [number, number] | null;
  /**
   * TASK-934 (G-2 / OD-4) — the six decode knobs that were Python literals in
   * `InferenceConfig` with no wire, no agent-schema key and no descriptor: one number for
   * every agent and every tenant on the box. They are now settable at BOTH tiers, agent
   * first, model profile second (OD-3).
   *
   * All six follow the omit-when-absent rule (`chunkLengthSec` above states why): ABSENT
   * means neither tier spoke and `apps/stt`'s dataclass default stands — the one source of
   * engine defaults. `null` is never written here.
   */
  noSpeechThreshold?: number;
  compressionRatioThreshold?: number;
  logprobThreshold?: number;
  conditionOnPrevTokens?: boolean;
  noRepeatNgramSize?: number;
  prevTextContextWords?: number;
  /**
   * TASK-934 — which TIER supplied each knob whose value two tiers could have decided
   * (`'agent'` = the agent's `parameters`, `'model'` = the ASR row's `_metadata.asr`
   * profile). Covers this block's knobs plus `hotwords`, `initialPrompt` and
   * `partialWindowSec`, which travel in `instruction` / `models.asr.metadata` but are
   * decided by the same precedence.
   *
   * OBSERVABILITY ONLY — the runtime must never branch on it. Omitted (never `{}`) when
   * neither tier decided anything, per the omit-when-absent rule.
   */
  sources?: Readonly<Record<string, AsrSpecDecodingSource>>;
}

/**
 * TASK-935 (OD-2 a) — the deterministic clinical-vocabulary correction stage.
 *
 * Note what is NOT here: the TERMS. They are `instruction.hotwords`, which the
 * resolver already fills (agent → the ASR row's `decoding.hotwords`) for the decoder
 * prompt, and OD-5 (a) makes this stage the SECOND consumer of that one list rather
 * than the owner of a second one. Duplicating them here would put two lists on one
 * wire, free to disagree about what the tenant asked for.
 *
 * `maxDistance` follows the omit-when-absent rule: absent means the agent did not tune
 * it and `LexiconCorrector`'s own default (0.34) stands — the one source of that default.
 */
export interface AsrSpecLexicon {
  enabled: boolean;
  maxDistance?: number;
}

/** §3.2 `postProcessing` — replaces `postprocessing.*`. */
export interface AsrSpecPostProcessing {
  punctuation: { enabled: boolean };
  disfluency: boolean;
  stabilizer: boolean;
  merge: boolean;
  /**
   * TASK-935 — OPTIONAL on the wire with the omit-when-absent rule (`decoding.chunkLengthSec`
   * states why). ABSENT means the agent expressed no opinion, and the runtime's default
   * then depends on the vocabulary itself: the stage is ON exactly when the resolved
   * hotword list is non-empty, because a term named for the decoder is a term the
   * clinician expects to read back. An explicit `enabled: false` is a VETO and is carried.
   */
  lexicon?: AsrSpecLexicon;
}

/**
 * Tuning for `endpointing: 'semantic'`. OPTIONAL on the wire with the same
 * omit-when-absent rule as the `decoding` chunking fields; a `null` member means
 * "the agent said nothing", so `apps/stt`'s `EndpointConfig` default stands.
 *
 * These four replace `stt.semanticEndpoint.{minSilenceMs,maxSilenceMs,confidenceThreshold,minWords}`
 * — the platform family TASK-877 deleted, because the agent owns the behaviour.
 */
export interface AsrSpecStreamingSemantic {
  minSilenceMs: number | null;
  maxSilenceMs: number | null;
  confidenceThreshold: number | null;
  minWords: number | null;
}

/** §3.2 `streaming`. */
export interface AsrSpecStreaming {
  partialIntervalMs: number | null;
  endpointing: AsrSpecEndpointing;
  maxUtteranceSec: number | null;
  semantic?: AsrSpecStreamingSemantic | null;
}

/** The agent's `instruction` block — literal decoder prompt text, never a template id. */
export interface AsrSpecInstruction {
  initialPrompt: string | null;
  hotwords: string[];
}

/** Which agent version produced this spec, and how it was chosen. */
export interface AsrSpecAgent {
  slug: string;
  versionId: string;
  versionNumber: number;
  /** The tenant that owns the agent row (the caller's, or SYSTEM for a platform default). */
  tenantId: string;
  source: ResolvedAgent['source'];
}

/**
 * Everything the runtime needs to assemble ONE engine chain. `runtimeKey` is the
 * identity `apps/stt` keys its session runtime, transcript stamps and usage rows
 * on — it takes the place `pipelineId` had (the agent VERSION id for a primary,
 * a derived key for a model-level fallback) and must differ between a spec and
 * its fallback so an engine switch is observable.
 */
export interface AsrSpecCore {
  runtimeKey: string;
  agent: AsrSpecAgent;
  models: AsrSpecModels;
  audioFrontEnd: AsrSpecAudioFrontEnd;
  decoding: AsrSpecDecoding;
  postProcessing: AsrSpecPostProcessing;
  streaming: AsrSpecStreaming;
  instruction: AsrSpecInstruction;
}

/**
 * §3.2 `fallback` — replaces `TenantSttConfig.fallbackPipelineId` /
 * `autoSwitchEnabled`. `kind: 'agent'` = another published SPEECH_TO_TEXT agent
 * (`parameters.fallback.agentSlug`); `kind: 'model'` = the agent's own ordered
 * `AgentModelFallback` chain (first enabled entry) over the same front-end;
 * `kind: 'none'` = nothing to switch to (`spec` is `null`).
 */
export interface AsrSpecFallback {
  kind: 'none' | 'agent' | 'model';
  autoSwitch: boolean;
  switchAfterConsecutiveFailures: number;
  spec: AsrSpecCore | null;
}

export interface ResolvedAsrSpec extends AsrSpecCore {
  schemaVersion: ResolvedAsrSpecSchemaVersion;
  fallback: AsrSpecFallback;
}
