/**
 * TASK-861 — the ONE producer of `ResolvedAsrSpec` (`@arcaai/types`), the
 * gateway → `apps/stt` runtime contract that replaces `AsrPipeline.configYaml`.
 *
 * PURE: no I/O, no DI. It folds a TASK-863 `ResolvedAgent` (already
 * tenant-scoped, models already materialised, credentials already resolved
 * out-of-band) into the §3.2 blocks `apps/stt` consumes. Anything that needs a
 * repository lives in `AsrAgentResolverService`; anything that decides what the
 * runtime DOES lives here, so the committed contract fixture can pin it.
 *
 * Defaults policy: a tuning field the agent did not set is `null` — the spec
 * carries what the agent SAID. `apps/stt`'s own dataclass defaults remain the
 * single source of engine defaults. The two exceptions are governance knobs the
 * runtime must always receive: `fallback.autoSwitch` (on) and
 * `switchAfterConsecutiveFailures` (2) — the former `TenantSttConfig` code
 * defaults, carried over verbatim.
 */
import type {
  AiModelAsrProfile,
  AiModelAsrProfileDecoding,
  AsrSpecAudioFrontEnd,
  AsrSpecCore,
  AsrSpecDecoding,
  AsrSpecDecodingSource,
  AsrSpecFallback,
  AsrSpecInstruction,
  AsrSpecModel,
  AsrSpecModelMetadata,
  AsrSpecModelRole,
  AsrSpecModels,
  AsrSpecPostProcessing,
  AsrSpecStreaming,
  AsrSpecStreamingSemantic,
  ResolvedAgent,
  ResolvedAgentModel,
  ResolvedAsrSpec,
} from '@arcaai/types';
import { ASR_SPEC_ROLE_TASK_TYPE, RESOLVED_ASR_SPEC_SCHEMA_VERSION, parseAiModelAsrProfile } from '@arcaai/types';
import { AGENT_FALLBACK_DEFAULTS } from '@arcaai/workflow-contract';

/**
 * The agent `fallback` block's governance defaults.
 *
 * TASK-880 renamed this from the ASR-specific spelling and re-exports the ONE declaration in
 * `@arcaai/workflow-contract` instead of re-typing the literals. TASK-876 moved fallback
 * governance onto the contract (autoSwitch ON, threshold 2 — a platform HA capability, not an
 * ASR opinion) and its comment already said this builder read from there; it did not, and the
 * two copies were free to drift. Re-exported HERE because that is where the ASR call sites
 * import it from.
 */
export { AGENT_FALLBACK_DEFAULTS } from '@arcaai/workflow-contract';

/** Raised when a resolved agent cannot become a runnable spec (fail closed — never a guessed engine). */
export class AsrSpecBuildError extends Error {
  /** Machine-readable cause; the resolver surfaces it as the 409 body's `code`. */
  readonly code:
    'ASR_AGENT_UNRUNNABLE' | 'ASR_AGENT_DIARIZATION_MODEL_MISSING' | 'ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED' | 'ASR_AGENT_VAD_MODEL_MISSING';

  constructor(message: string, code: AsrSpecBuildError['code'] = 'ASR_AGENT_UNRUNNABLE') {
    super(message);
    this.name = 'AsrSpecBuildError';
    this.code = code;
  }
}

/** What an ASR row's `_metadata.asr` declared that this builder could not act on. */
export interface AsrProfileRejection {
  modelSlug: string;
  /** Dotted paths, from `parseAiModelAsrProfile` — an unknown key, a wrong type or an out-of-range value. */
  rejected: string[];
}

/**
 * TASK-958 D-4 — the identity of the `AiProviderConnection` that serves ONE engine
 * chain, and the key its credential arrives under in `provider_overrides`.
 *
 * Plain DATA rather than a callback, so the committed contract fixture can express
 * it: this module stays PURE, and the resolver (which owns the credential lookup)
 * decides the values.
 */
export interface AsrConnectionBinding {
  connectionId: string;
  /**
   * OPTIONAL since G2a's F7: a binding that FAILED CLOSED still declares itself on the
   * core (id + key), but the tenant's own name for the row may not be readable — the
   * connection plane is optional on the resolver, and the row may be gone. The key is
   * namespaced either way, so a missing slug can never make it collide.
   */
  connectionSlug?: string;
  connectionKey: string;
}

export interface BuildResolvedAsrSpecInput {
  agent: ResolvedAgent;
  /** The resolved `parameters.fallback.agentSlug` agent, when the primary names one. */
  fallbackAgent?: ResolvedAgent | null;
  /**
   * TASK-958 — the connection each of the TWO engine chains authenticates as.
   *
   * Two, because a spec has exactly two cores: the primary and (at most) one
   * fallback. Absent/`null` for a chain whose ASR row names no connection (a SYSTEM
   * catalogue row), in which case the core carries no connection fields at all and
   * `apps/stt` falls back to the provider id — the pre-958 behaviour, byte for byte.
   */
  connections?: { primary?: AsrConnectionBinding | null; fallback?: AsrConnectionBinding | null };
  /**
   * TASK-934 — called once per engine chain whose ASR row declared something unusable.
   *
   * Tuning is `open-to-default`, so a bad member is dropped and the session proceeds; this
   * is how it stops being SILENT. The callback keeps this module PURE — the caller
   * (`AsrAgentResolverService`) owns the logger.
   */
  onProfileRejection?: (rejection: AsrProfileRejection) => void;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {});
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
/** `[left, right]` context seconds. Anything else is no opinion, never a half-read pair. */
const pair = (value: unknown): readonly [number, number] | null =>
  Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [value[0] as number, value[1] as number]
    : null;

/**
 * TASK-880 / TASK-934 — the `AiModel._metadata.asr` profile the runtime may act on, normalised.
 *
 * The parsing (ranges, unknown keys, non-numeric members) belongs to
 * `parseAiModelAsrProfile` in `@arcaai/types`, which is the ONE gate the admin API (the
 * write side) and this builder (the read side) share. What is decided HERE is what reaches
 * the wire:
 *
 * - `maxDecodeWindowSec` — the ROW's, always (OD-3: geometry is a property of the weights);
 * - `partialWindowSec` — the EFFECTIVE value, so an agent-level override (OD-4) arrives where
 *   `apps/stt` already reads it and no consumer had to learn a second path;
 * - `decoding` / `initialPrompt` — the row's recommendation VERBATIM, as provenance. The
 *   effective values live in `decoding` / `instruction`; `decoding.sources` says who won.
 *
 * OMITTED (never `null`, never `{}`) when nothing survives: `apps/stt`'s mirror is
 * `extra='forbid'` and reads an absent key as "no opinion, keep my own default", so an
 * empty object would be a second encoding of one state.
 */
function specModelMetadata(profile: AiModelAsrProfile, partialWindowSecOverride?: number): AsrSpecModelMetadata | undefined {
  const out: AsrSpecModelMetadata = {};
  if (profile.maxDecodeWindowSec !== undefined) out.maxDecodeWindowSec = profile.maxDecodeWindowSec;
  const partialWindowSec = partialWindowSecOverride ?? profile.partialWindowSec;
  if (partialWindowSec !== undefined) out.partialWindowSec = partialWindowSec;
  if (profile.decoding) out.decoding = profile.decoding;
  if (profile.initialPrompt !== undefined) out.initialPrompt = profile.initialPrompt;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The row's profile, parsed; rejections are REPORTED rather than swallowed (tuning is open-to-default). */
function profileOf(model: ResolvedAgentModel, onProfileRejection?: (rejection: AsrProfileRejection) => void): AiModelAsrProfile {
  const { profile, rejected } = parseAiModelAsrProfile(rec(model.metaData).asr);
  if (rejected.length > 0) onProfileRejection?.({ modelSlug: model.slug, rejected });
  return profile;
}

function toSpecModel(model: ResolvedAgentModel, role: AsrSpecModelRole, metadata = specModelMetadata(profileOf(model))): AsrSpecModel {
  return {
    role,
    slug: model.slug,
    taskType: ASR_SPEC_ROLE_TASK_TYPE[role],
    format: model.format,
    // TASK-944 (B2) — the field `apps/stt` selects its loader with; omitted, never
    // `null`, so the two halves stay independently deployable against `extra: forbid`.
    ...(model.libraryName ? { libraryName: model.libraryName } : {}),
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? null,
    // Already DERIVED by `AgentResolverService` (TASK-890 §3.11); forwarded verbatim.
    localPath: model.localPath ?? null,
    checksum: model.checksum ?? null,
    computeType: model.computeType ?? null,
    provider: model.provider ?? null,
    tenantId: model.tenantId,
    ...(metadata ? { metadata } : {}),
  };
}

function primaryOf(agent: ResolvedAgent): ResolvedAgentModel {
  const primary = agent.models.find((m) => m.role === 'primary');
  if (!primary) throw new AsrSpecBuildError(`Agent '${agent.slug}' v${agent.versionNumber} resolved no primary ASR model.`);
  return primary;
}

/**
 * The aux models this spec SHIPS.
 *
 * TASK-977 (owner decision D-4) — `vad`, `denoise` and `embedding` belong to audio
 * front-end STAGES, so a stage the spec declares OFF ships no model for it: `apps/stt`
 * warms and pins whatever `models.*` names (`session_manager._load_optional`,
 * `batch_service._load_models`) on ref presence alone, and "disabled" must cost zero
 * model loads. `punctuation` and `endpointing` are not front-end stages — they are
 * post-ASR services with their own enable flags elsewhere in the spec — so they are
 * copied unconditionally, exactly as before.
 */
function auxModels(agent: ResolvedAgent, front: AsrSpecAudioFrontEnd): Omit<AsrSpecModels, 'asr'> {
  const out: Omit<AsrSpecModels, 'asr'> = {};
  const shipsStage: Partial<Record<AsrSpecModelRole, boolean>> = {
    vad: front.vad.enabled,
    denoise: front.denoise.enabled,
    embedding: front.diarization.enabled,
  };
  for (const role of ['vad', 'denoise', 'embedding', 'punctuation', 'endpointing'] as const) {
    if (shipsStage[role] === false) continue;
    const found = agent.models.find((m) => m.role === role);
    if (found) out[role] = toSpecModel(found, role);
  }
  return out;
}

function audioFrontEnd(parameters: Rec): AsrSpecAudioFrontEnd {
  const afe = rec(parameters.audioFrontEnd);
  const vad = rec(afe.vad);
  const denoise = rec(afe.denoise);
  const diarization = rec(afe.diarization);
  // TASK-977 (D-2) — enablement is DECLARED, never inferred from model binding. `enabled`
  // and `level` are two spellings of one decision, so they are resolved together and can
  // never disagree: off ⇒ `level: 'off'` whatever the agent wrote, and an enabled stage
  // with no level runs at `medium` (the strength binding a model used to imply).
  const level = bool(denoise.enabled, false) ? oneOf(denoise.level, ['off', 'low', 'medium', 'high'] as const, 'medium') : 'off';
  // TASK-880 — `speechPadMs` replaces the platform key `stt.vad.speechPadMs`. OMITTED
  // when the agent said nothing (the omit-when-absent rule the TASK-877 additions use),
  // so `VadConfig.padding_ms` remains the one source of the engine default.
  const speechPadMs = num(vad.speechPadMs);
  const matchThreshold = num(diarization.matchThreshold);
  return {
    vad: {
      // TASK-977 (D-1) — was the literal `true`. The tuning fields beside it are carried
      // whatever the flag says: they are what the agent SAID, and stating a threshold is
      // not consent to run the stage.
      enabled: bool(vad.enabled, false),
      threshold: num(vad.threshold),
      minSpeechMs: num(vad.minSpeechMs),
      minSilenceMs: num(vad.minSilenceMs),
      ...(speechPadMs !== null ? { speechPadMs } : {}),
    },
    denoise: { enabled: level !== 'off', level },
    diarization: {
      enabled: bool(diarization.enabled, false),
      // TASK-980 — `embedding` is the only backend left. Anything else an ENABLED stage stored was
      // already refused by `assertDiarizationBackendSupported`; a disabled stage runs nothing, so
      // whatever it stored there is nothing to honour.
      backend: 'embedding',
      maxSpeakers: num(diarization.maxSpeakers),
      // TASK-887 — replaces the platform key `stt.voiceProfile.minSimilarity`. OMITTED when the
      // agent said nothing, so `DiarizationConfig.match_threshold` stays the one engine default.
      ...(matchThreshold !== null ? { matchThreshold } : {}),
    },
    resample: bool(afe.resample, true),
    normalize: bool(afe.normalize, true),
  };
}

/**
 * TASK-934 (OD-3) — the knobs BOTH tiers can decide, in the order they are resolved:
 * the agent's `parameters.decoding.<key>` first, the ASR row's profile second, absence
 * third (the engine dataclass default). They are numbers; `conditionOnPrevTokens` and
 * `hotwords` / `initialPrompt` are resolved beside them with the same rule.
 *
 * `beamSize` and `temperature` predate the profile and stay REQUIRED-but-nullable on the
 * wire; the six after them are omit-when-absent.
 */
const OPTIONAL_DECODING_KNOBS = [
  'noSpeechThreshold',
  'compressionRatioThreshold',
  'logprobThreshold',
  'noRepeatNgramSize',
  'prevTextContextWords',
] as const;

type Sources = Record<string, AsrSpecDecodingSource>;

function decoding(parameters: Rec, profile: AiModelAsrProfile, sources: Sources): AsrSpecDecoding {
  const d = rec(parameters.decoding);
  const p = profile.decoding ?? {};
  /** Agent → profile → `null`. The agent's range gate is the published agent schema; the row's is `parseAiModelAsrProfile`. */
  const pick = (key: keyof AiModelAsrProfileDecoding): number | null => {
    const agentValue = num(d[key]);
    if (agentValue !== null) {
      sources[key] = 'agent';
      return agentValue;
    }
    const modelValue = p[key];
    if (typeof modelValue === 'number') {
      sources[key] = 'model';
      return modelValue;
    }
    return null;
  };
  const block: AsrSpecDecoding = {
    languageMode: str(d.languageMode),
    codeSwitching: bool(d.codeSwitching, false),
    wordTimestamps: bool(d.wordTimestamps, false),
    beamSize: pick('beamSize'),
    temperature: pick('temperature'),
    vadFilter: bool(d.vadFilter, false),
  };
  // Owner decision #9 — per-agent batch chunking. OMITTED, not `null`, when the
  // agent said nothing: `apps/stt`'s mirror is `extra='forbid'`, so the key must be
  // absent until both halves have learned it (they may deploy in either order), and
  // absence is also what tells the batch path to keep the platform values.
  const chunkLengthSec = num(d.chunkLengthSec);
  if (chunkLengthSec !== null) block.chunkLengthSec = chunkLengthSec;
  const strideLengthSec = pair(d.strideLengthSec);
  if (strideLengthSec !== null) block.strideLengthSec = strideLengthSec;
  // TASK-934 (G-2) — the six knobs that were Python literals. Same omit-when-absent rule:
  // neither tier spoke ⇒ the key is absent ⇒ `InferenceConfig`'s default stands.
  for (const key of OPTIONAL_DECODING_KNOBS) {
    const value = pick(key);
    if (value !== null) block[key] = value;
  }
  const agentConditionOnPrevTokens = typeof d.conditionOnPrevTokens === 'boolean' ? d.conditionOnPrevTokens : undefined;
  const conditionOnPrevTokens = agentConditionOnPrevTokens ?? p.conditionOnPrevTokens;
  if (conditionOnPrevTokens !== undefined) {
    sources.conditionOnPrevTokens = agentConditionOnPrevTokens !== undefined ? 'agent' : 'model';
    block.conditionOnPrevTokens = conditionOnPrevTokens;
  }
  // TASK-946 (OD-1) — the hotword-prompt switch, folded on the same two tiers and with
  // the same omit-when-absent rule. Absence is the whole point: it is what leaves the
  // engine's own default (OFF for whisper.cpp) standing, so a row that says nothing gets
  // the safe answer rather than the one that collapsed the ml-en fine-tune's script.
  const agentHotwordsInPrompt = typeof d.hotwordsInPrompt === 'boolean' ? d.hotwordsInPrompt : undefined;
  const hotwordsInPrompt = agentHotwordsInPrompt ?? p.hotwordsInPrompt;
  if (hotwordsInPrompt !== undefined) {
    sources.hotwordsInPrompt = agentHotwordsInPrompt !== undefined ? 'agent' : 'model';
    block.hotwordsInPrompt = hotwordsInPrompt;
  }
  return block;
}

/**
 * TASK-934 (OD-4) — the partial tail, resolved.
 *
 * The DECODE window is the row's alone (model geometry), but the PARTIAL window is a
 * streaming-behaviour choice the agent may take: §2.2 measured 31 % garbage partials at 6 s
 * against 0 % at 15 s on the same weights. Agent → row → absent.
 */
function partialWindowSecOf(parameters: Rec, profile: AiModelAsrProfile, sources: Sources): number | undefined {
  const agentValue = num(rec(parameters.streaming).partialWindowSec);
  if (agentValue !== null) {
    sources.partialWindowSec = 'agent';
    return agentValue;
  }
  if (profile.partialWindowSec !== undefined) {
    sources.partialWindowSec = 'model';
    return profile.partialWindowSec;
  }
  return undefined;
}

function postProcessing(parameters: Rec): AsrSpecPostProcessing {
  const p = rec(parameters.postProcessing);
  const block: AsrSpecPostProcessing = {
    punctuation: { enabled: bool(rec(p.punctuation).enabled, true) },
    disfluency: bool(p.disfluency, false),
    stabilizer: bool(p.stabilizer, false),
    merge: bool(p.merge, false),
  };
  // TASK-935 (OD-2 a) — the clinical-vocabulary correction stage. OMITTED, not `null` and
  // not defaulted, when the agent said nothing: `apps/stt`'s mirror is `extra='forbid'`,
  // and absence is also what lets the runtime apply the conditional default (ON exactly
  // when the resolved hotwords are non-empty) that no single value here could express.
  // The terms are NOT copied in — they are `instruction.hotwords`, one list (OD-5 a).
  const lexicon = rec(p.lexicon);
  const enabled = typeof lexicon.enabled === 'boolean' ? lexicon.enabled : null;
  const maxDistance = num(lexicon.maxDistance);
  if (enabled !== null || maxDistance !== null) {
    // A bare `maxDistance` is an author tuning a stage they meant to run.
    block.lexicon = { enabled: enabled ?? true, ...(maxDistance !== null ? { maxDistance } : {}) };
  }
  return block;
}

function streaming(parameters: Rec): AsrSpecStreaming {
  const s = rec(parameters.streaming);
  const block: AsrSpecStreaming = {
    partialIntervalMs: num(s.partialIntervalMs),
    endpointing: oneOf(s.endpointing, ['fixed', 'semantic'] as const, 'fixed'),
    maxUtteranceSec: num(s.maxUtteranceSec),
  };
  // The four knobs that replace `stt.semanticEndpoint.*`. Same omit-when-absent
  // rule as the chunking fields; a declared-but-empty block is still omitted, so
  // "the agent set nothing" and "the agent set nothing useful" look identical on
  // the wire rather than producing two encodings of one state.
  const semantic: AsrSpecStreamingSemantic = {
    minSilenceMs: num(rec(s.semantic).minSilenceMs),
    maxSilenceMs: num(rec(s.semantic).maxSilenceMs),
    confidenceThreshold: num(rec(s.semantic).confidenceThreshold),
    minWords: num(rec(s.semantic).minWords),
  };
  if (Object.values(semantic).some((v) => v !== null)) block.semantic = semantic;
  return block;
}

/**
 * The decoder prompt and the hotword set, resolved agent → model profile → absent.
 *
 * OD-11 — a priming prompt is a per-FINE-TUNE property (§2.2: the seeded agent's prompt costs
 * ≈0.06 CER on the Malayalam set while helping long English utterances), so the row may
 * carry one. Both fold into `instruction`, which is where `apps/stt` already reads them:
 * one wire path per engine field, never two.
 *
 * The agent's hotword list wins WHOLE, never merged — a curated set is an author's decision,
 * and a silent union would put terms in the decode that neither tier asked for.
 */
function instruction(agent: ResolvedAgent, profile: AiModelAsrProfile, sources: Sources): AsrSpecInstruction {
  const i = rec(agent.compiledConfig.instruction);
  const agentHotwords = Array.isArray(i.hotwords) ? i.hotwords.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];
  const agentPrompt = str(i.initialPrompt);
  const profileHotwords = profile.decoding?.hotwords;

  let initialPrompt = agentPrompt;
  if (agentPrompt !== null) sources.initialPrompt = 'agent';
  else if (profile.initialPrompt !== undefined) {
    initialPrompt = profile.initialPrompt;
    sources.initialPrompt = 'model';
  }

  let hotwords = agentHotwords;
  if (agentHotwords.length > 0) sources.hotwords = 'agent';
  else if (profileHotwords !== undefined && profileHotwords.length > 0) {
    hotwords = [...profileHotwords];
    sources.hotwords = 'model';
  }
  return { initialPrompt, hotwords };
}

/**
 * TASK-980 (owner decision 2026-09-16) — the `sortformer` diarization backend is RETIRED.
 *
 * A published agent version is immutable stored content, so one may still declare
 * `backend: 'sortformer'` (or any other value the schema no longer admits). Coercing that to
 * `embedding` — which is what `oneOf(…, 'embedding')` did — would silently run a diarizer the agent
 * never declared, so an ENABLED stage whose stored backend is present and is not `embedding` is
 * REFUSED. A disabled stage runs nothing and is left alone; an absent backend means `embedding`.
 *
 * Read from the RAW parameters, before `audioFrontEnd` normalises them, because that is the only
 * place the stored value still exists.
 */
function assertDiarizationBackendSupported(agent: ResolvedAgent, parameters: Rec): void {
  const diarization = rec(rec(parameters.audioFrontEnd).diarization);
  const backend = diarization.backend;
  if (!bool(diarization.enabled, false) || backend === undefined || backend === 'embedding') return;
  const stored = typeof backend === 'string' ? `'${backend}'` : JSON.stringify(backend);
  throw new AsrSpecBuildError(
    `Agent '${agent.slug}' v${agent.versionNumber} enables speaker diarization with the ${stored} backend, ` +
      `which this platform cannot run: the \`sortformer\` backend was retired (TASK-980) and \`embedding\` is the only supported ` +
      `backend. Publish a new version with \`audioFrontEnd.diarization.backend\` set to \`embedding\` (and an ` +
      `\`embeddingModelSlug\`), or switch diarization off.`,
    'ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED',
  );
}

/**
 * TASK-887 — an agent that turns diarization ON must NAME the embedding model.
 *
 * This REPLACES TASK-880's `ASR_AGENT_EMBEDDING_SPACE_MISMATCH`. That guard existed because
 * the platform declared one embedding space (`stt.diarization.hfModelId`) and the
 * `UserVoiceProfile.embedding` column was `vector(256)`, so an agent binding a 192-d row
 * would have written vectors the column could not hold. Under the owner's decision the agent
 * IS the space: a profile is stored with the model that embedded it (`UserVoiceProfile.modelId`)
 * in a dimension-agnostic `vector` column, and matching only ever considers profiles from the
 * SAME model. A width mismatch is therefore impossible by construction, and there is nothing
 * left to refuse on that ground.
 *
 * What IS refusable is an agent that asks for diarization and names no model. Model
 * SELECTION fails closed (rule 09 §Configuration Tiers): substituting a platform default here
 * is exactly the behaviour this ticket removed, and silently diarizing without one would drop
 * every enrolled label without saying so. Since TASK-980 every enabled stage is an `embedding`
 * stage (any other stored backend is refused first), so there is no backend left to exempt.
 */
function assertDiarizationRunnable(agent: ResolvedAgent, afe: AsrSpecAudioFrontEnd, embedding: AsrSpecModel | undefined): void {
  if (!afe.diarization.enabled || embedding) return;
  throw new AsrSpecBuildError(
    `Agent '${agent.slug}' v${agent.versionNumber} enables embedding diarization but binds no speaker-embedding model. ` +
      `Set \`audioFrontEnd.diarization.embeddingModelSlug\` to a SPEAKER_EMBEDDING model visible to this tenant — ` +
      `it is the vector space this agent diarizes in and the space its users enrol their voice profiles in.`,
    'ASR_AGENT_DIARIZATION_MODEL_MISSING',
  );
}

/**
 * TASK-977 (owner decision D-3) — an agent that turns VAD ON must NAME the VAD model.
 *
 * The guard above, applied to the stage this ticket stopped forcing on. Silero needs
 * weights, and `_load_vad_service` resolves them from the session's own
 * `models.vad.localPath`; with no row it passes `None` and the service falls back to
 * whatever the HuggingFace cache happens to hold. That is a model SELECTION nobody made
 * — the same silent substitution TASK-887 removed from diarization — so it is refused.
 *
 * DENOISE deliberately has no such guard, and that asymmetry is the finding, not an
 * oversight: the denoise engines are RUNTIME-owned. `StreamingDenoiser.initialize()`
 * constructs `pyrnnoise.RNNoise(sample_rate=48000)` and
 * `DeepFilterNet3StreamingDenoiser.initialize()` calls
 * `init_df(default_model='DeepFilterNet3')` — weights shipped inside the wheel — and the
 * engine is chosen by NAME (`DenoiseConfig.engine`, default `rnnoise`), never from
 * `models.denoise`, which is only ever warmed into the model cache and never read back by
 * a denoise call. Requiring an `AiModel` row to denoise would refuse the default working
 * configuration.
 */
function assertVadRunnable(agent: ResolvedAgent, afe: AsrSpecAudioFrontEnd, vad: AsrSpecModel | undefined): void {
  if (!afe.vad.enabled || vad) return;
  throw new AsrSpecBuildError(
    `Agent '${agent.slug}' v${agent.versionNumber} enables voice-activity detection but binds no VAD model. ` +
      `Set \`audioFrontEnd.vad.modelSlug\` to a VOICE_ACTIVITY_DETECTION model visible to this tenant, or leave ` +
      `\`audioFrontEnd.vad.enabled\` off and let the runtime segment on energy.`,
    'ASR_AGENT_VAD_MODEL_MISSING',
  );
}

/**
 * One engine chain for `agent`, optionally with its primary ASR model swapped (model-level fallback).
 *
 * TASK-934 — the chain resolves against ITS OWN ASR row's profile, which is the point of
 * putting the profile on the row: a fallback engine gets its own decode parameters instead
 * of inheriting the primary's.
 */
export function buildAsrSpecCore(
  agent: ResolvedAgent,
  override?: { asr: ResolvedAgentModel; runtimeKey: string },
  onProfileRejection?: (rejection: AsrProfileRejection) => void,
  connection?: AsrConnectionBinding | null,
): AsrSpecCore {
  const parameters = rec(agent.compiledConfig.parameters);
  const asrModel = override?.asr ?? primaryOf(agent);
  const profile = profileOf(asrModel, onProfileRejection);
  // One map, written by the three resolvers below and attached to `decoding` at the end —
  // observability only, so a live session can be explained without re-deriving precedence.
  const sources: Sources = {};
  const partialWindowSec = partialWindowSecOf(parameters, profile, sources);
  // TASK-977 — the front end is resolved FIRST and then decides which aux models ship.
  // Before D-2 this ran the other way round (the denoise level was read off the bound
  // model), which is why a disabled stage could not drop its model.
  // TASK-980 — refused on the STORED backend, before `audioFrontEnd` normalises it away. This core
  // builds every chain (primary, model-level fallback, fallback agent), so all three are covered.
  assertDiarizationBackendSupported(agent, parameters);
  const front = audioFrontEnd(parameters);
  const models: AsrSpecModels = { asr: toSpecModel(asrModel, 'asr', specModelMetadata(profile, partialWindowSec)), ...auxModels(agent, front) };
  assertVadRunnable(agent, front, models.vad);
  assertDiarizationRunnable(agent, front, models.embedding);
  const decodingBlock = decoding(parameters, profile, sources);
  const instructionBlock = instruction(agent, profile, sources);
  if (Object.keys(sources).length > 0) decodingBlock.sources = sources;
  return {
    runtimeKey: override?.runtimeKey ?? agent.agentVersionId,
    // OMITTED, never nulled: `stt.pipeline.spec.AsrSpecCore` is `extra='forbid'` and
    // lists all three in its `OPTIONAL_FIELDS`, so an unset optional has to be absent
    // for the two halves to stay independently deployable.
    ...(connection
      ? {
          connectionId: connection.connectionId,
          ...(connection.connectionSlug ? { connectionSlug: connection.connectionSlug } : {}),
          connectionKey: connection.connectionKey,
        }
      : {}),
    agent: { slug: agent.slug, versionId: agent.agentVersionId, versionNumber: agent.versionNumber, tenantId: agent.tenantId, source: agent.source },
    models,
    audioFrontEnd: front,
    decoding: decodingBlock,
    postProcessing: postProcessing(parameters),
    streaming: streaming(parameters),
    instruction: instructionBlock,
  };
}

/**
 * The ASR model each of the two engine chains runs on — the ONE selection rule, so
 * the resolver (which must know the chains to resolve their credentials, before the
 * spec exists) and `fallbackOf` below cannot disagree about which row is which.
 *
 * `primary` is `undefined` for an agent that resolved none: the builder raises for
 * that, and a caller resolving credentials first must not.
 */
export function asrChainModels(
  agent: ResolvedAgent,
  fallbackAgent?: ResolvedAgent | null,
): { primary: ResolvedAgentModel | undefined; fallback: ResolvedAgentModel | undefined } {
  const primary = agent.models.find((m) => m.role === 'primary');
  if (fallbackAgent) return { primary, fallback: fallbackAgent.models.find((m) => m.role === 'primary') };
  const chain = agent.models.filter((m) => m.role === 'fallback').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return { primary, fallback: chain[0] };
}

function fallbackOf(
  agent: ResolvedAgent,
  fallbackAgent: ResolvedAgent | null | undefined,
  onProfileRejection?: (rejection: AsrProfileRejection) => void,
  connection?: AsrConnectionBinding | null,
): AsrSpecFallback {
  const f = rec(rec(agent.compiledConfig.parameters).fallback);
  const governance = {
    autoSwitch: bool(f.autoSwitch, AGENT_FALLBACK_DEFAULTS.autoSwitch),
    switchAfterConsecutiveFailures: num(f.switchAfterConsecutiveFailures) ?? AGENT_FALLBACK_DEFAULTS.switchAfterConsecutiveFailures,
  };
  if (fallbackAgent) {
    return { kind: 'agent', ...governance, spec: buildAsrSpecCore(fallbackAgent, undefined, onProfileRejection, connection) };
  }
  const first = asrChainModels(agent).fallback;
  if (first) {
    const runtimeKey = `${agent.agentVersionId}:fallback:${first.slug}`;
    return { kind: 'model', ...governance, spec: buildAsrSpecCore(agent, { asr: first, runtimeKey }, onProfileRejection, connection) };
  }
  return { kind: 'none', ...governance, spec: null };
}

export function buildResolvedAsrSpec(input: BuildResolvedAsrSpecInput): ResolvedAsrSpec {
  const { agent, fallbackAgent, onProfileRejection, connections } = input;
  if (agent.task !== 'SPEECH_TO_TEXT') {
    throw new AsrSpecBuildError(`Agent '${agent.slug}' is a ${agent.task} agent; an ASR spec needs SPEECH_TO_TEXT.`);
  }
  if (fallbackAgent && fallbackAgent.task !== 'SPEECH_TO_TEXT') {
    throw new AsrSpecBuildError(`Fallback agent '${fallbackAgent.slug}' is a ${fallbackAgent.task} agent; an ASR fallback needs SPEECH_TO_TEXT.`);
  }
  return {
    schemaVersion: RESOLVED_ASR_SPEC_SCHEMA_VERSION,
    ...buildAsrSpecCore(agent, undefined, onProfileRejection, connections?.primary),
    fallback: fallbackOf(agent, fallbackAgent, onProfileRejection, connections?.fallback),
  };
}
