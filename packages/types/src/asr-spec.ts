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

import type { ResolvedAgent } from './agent.js';

export const RESOLVED_ASR_SPEC_SCHEMA_VERSION = 1 as const;
export type ResolvedAsrSpecSchemaVersion = typeof RESOLVED_ASR_SPEC_SCHEMA_VERSION;

/** The roles a resolved model plays in the ASR runtime. */
export const ASR_SPEC_MODEL_ROLES = ['asr', 'vad', 'denoise', 'embedding', 'punctuation'] as const;
export type AsrSpecModelRole = (typeof ASR_SPEC_MODEL_ROLES)[number];

/**
 * The registry `taskType` each role is loaded under. Mirrors
 * `apps/stt/src/stt/pipeline/dto.py#ModelTaskType` for the four the STT runtime
 * executes itself; `punctuation` is served by `apps/stt`'s punctuation service
 * (Cadence) and is referenced by slug only.
 */
export const ASR_SPEC_ROLE_TASK_TYPE: Readonly<Record<AsrSpecModelRole, string>> = Object.freeze({
  asr: 'AUTOMATIC_SPEECH_RECOGNITION',
  vad: 'VOICE_ACTIVITY_DETECTION',
  denoise: 'AUDIO_TO_AUDIO',
  embedding: 'SPEAKER_EMBEDDING',
  punctuation: 'TOKEN_CLASSIFICATION',
});

/** One resolved registry row — the fields `apps/stt`'s `AiModelConfig` consumes. */
export interface AsrSpecModel {
  role: AsrSpecModelRole;
  slug: string;
  taskType: string;
  /** `AiModelFormat` value — selects the engine/loader in `apps/stt`. */
  format: string;
  sourceUri: string;
  sourceRevision: string | null;
  /** Operator/admin override — HIGHEST precedence in `resolve_model_dir`. TODO(TASK-860): derived from `bucketPrefix`. */
  localPath: string | null;
  checksum: string | null;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
}

export interface AsrSpecModels {
  asr: AsrSpecModel;
  vad?: AsrSpecModel;
  denoise?: AsrSpecModel;
  embedding?: AsrSpecModel;
  punctuation?: AsrSpecModel;
}

export type AsrSpecDenoiseLevel = 'off' | 'low' | 'medium' | 'high';
export type AsrSpecDiarizationBackend = 'embedding' | 'sortformer';
export type AsrSpecEndpointing = 'fixed' | 'semantic';

/** §3.2 `audioFrontEnd` — replaces `models.vad/denoise/embedding` + `preprocessing.*`. */
export interface AsrSpecAudioFrontEnd {
  vad: { enabled: boolean; threshold: number | null; minSpeechMs: number | null; minSilenceMs: number | null };
  denoise: { enabled: boolean; level: AsrSpecDenoiseLevel };
  diarization: { enabled: boolean; backend: AsrSpecDiarizationBackend; maxSpeakers: number | null };
  resample: boolean;
  normalize: boolean;
}

/** §3.2 `decoding` — replaces `inference.*`. `languageMode` is resolved per engine by `apps/stt`. */
export interface AsrSpecDecoding {
  languageMode: string | null;
  codeSwitching: boolean;
  wordTimestamps: boolean;
  beamSize: number | null;
  temperature: number | null;
  vadFilter: boolean;
}

/** §3.2 `postProcessing` — replaces `postprocessing.*`. */
export interface AsrSpecPostProcessing {
  punctuation: { enabled: boolean };
  disfluency: boolean;
  stabilizer: boolean;
  merge: boolean;
}

/** §3.2 `streaming`. */
export interface AsrSpecStreaming {
  partialIntervalMs: number | null;
  endpointing: AsrSpecEndpointing;
  maxUtteranceSec: number | null;
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
