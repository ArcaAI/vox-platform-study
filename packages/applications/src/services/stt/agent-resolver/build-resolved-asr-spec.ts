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
  AsrSpecAudioFrontEnd,
  AsrSpecCore,
  AsrSpecDecoding,
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
import { ASR_SPEC_ROLE_TASK_TYPE, RESOLVED_ASR_SPEC_SCHEMA_VERSION } from '@arcaai/types';
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

/**
 * The vector width the deployed `UserVoiceProfile.embedding` column holds —
 * `Unsupported("vector(256)")` in `packages/database/src/prisma/db_main/user.prisma`,
 * written by the 256-d wespeaker model the enrollment seed uses and that
 * `stt.diarization.hfModelId` names.
 *
 * TASK-880 — this is a SCHEMA fact mirrored here, not configuration: a pgvector column
 * width is fixed by DDL, so a spec that would write another width is unrunnable no
 * matter what any setting says. It is the reason `stt.diarization.hfModelId` is
 * deliberately NOT moved onto the agent (owner default assumption, option 1): the key
 * declares the embedding SPACE enrolled profiles live in, and an agent may pick a
 * diarization model only from within it.
 */
export const VOICE_PROFILE_EMBEDDING_DIMENSION = 256;

/** Raised when a resolved agent cannot become a runnable spec (fail closed — never a guessed engine). */
export class AsrSpecBuildError extends Error {
  /** Machine-readable cause; the resolver surfaces it as the 409 body's `code`. */
  readonly code: 'ASR_AGENT_UNRUNNABLE' | 'ASR_AGENT_EMBEDDING_SPACE_MISMATCH';

  constructor(message: string, code: AsrSpecBuildError['code'] = 'ASR_AGENT_UNRUNNABLE') {
    super(message);
    this.name = 'AsrSpecBuildError';
    this.code = code;
  }
}

export interface BuildResolvedAsrSpecInput {
  agent: ResolvedAgent;
  /** The resolved `parameters.fallback.agentSlug` agent, when the primary names one. */
  fallbackAgent?: ResolvedAgent | null;
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
 * TASK-880 — the `AiModel._metadata.asr` geometry the runtime may act on, normalised.
 *
 * OMITTED (never `null`, never `{}`) when the row declares nothing usable: `apps/stt`'s
 * mirror is `extra='forbid'` and treats an absent key as "no opinion, keep my own default",
 * so an empty object would be a second encoding of one state. A non-numeric member is
 * dropped rather than forwarded — the row is admin-editable JSON, and a string where the
 * runtime expects seconds must not reach a `float()`.
 */
function specModelMetadata(model: ResolvedAgentModel): AsrSpecModelMetadata | undefined {
  const asr = rec(rec(model.metaData).asr);
  const out: AsrSpecModelMetadata = {};
  const maxDecodeWindowSec = num(asr.maxDecodeWindowSec);
  if (maxDecodeWindowSec !== null) out.maxDecodeWindowSec = maxDecodeWindowSec;
  const partialWindowSec = num(asr.partialWindowSec);
  if (partialWindowSec !== null) out.partialWindowSec = partialWindowSec;
  return Object.keys(out).length > 0 ? out : undefined;
}

function toSpecModel(model: ResolvedAgentModel, role: AsrSpecModelRole): AsrSpecModel {
  const metadata = specModelMetadata(model);
  return {
    role,
    slug: model.slug,
    taskType: ASR_SPEC_ROLE_TASK_TYPE[role],
    format: model.format,
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? null,
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

function auxModels(agent: ResolvedAgent): Omit<AsrSpecModels, 'asr'> {
  const out: Omit<AsrSpecModels, 'asr'> = {};
  for (const role of ['vad', 'denoise', 'embedding', 'punctuation', 'endpointing'] as const) {
    const found = agent.models.find((m) => m.role === role);
    if (found) out[role] = toSpecModel(found, role);
  }
  return out;
}

function audioFrontEnd(parameters: Rec, models: AsrSpecModels): AsrSpecAudioFrontEnd {
  const afe = rec(parameters.audioFrontEnd);
  const vad = rec(afe.vad);
  const denoise = rec(afe.denoise);
  const diarization = rec(afe.diarization);
  // A denoise model with no explicit level means "on, engine default strength".
  const level = oneOf(denoise.level, ['off', 'low', 'medium', 'high'] as const, models.denoise ? 'medium' : 'off');
  // TASK-880 — `speechPadMs` replaces the platform key `stt.vad.speechPadMs`. OMITTED
  // when the agent said nothing (the omit-when-absent rule the TASK-877 additions use),
  // so `VadConfig.padding_ms` remains the one source of the engine default.
  const speechPadMs = num(vad.speechPadMs);
  return {
    vad: {
      enabled: true,
      threshold: num(vad.threshold),
      minSpeechMs: num(vad.minSpeechMs),
      minSilenceMs: num(vad.minSilenceMs),
      ...(speechPadMs !== null ? { speechPadMs } : {}),
    },
    denoise: { enabled: level !== 'off', level },
    diarization: {
      enabled: bool(diarization.enabled, false),
      backend: oneOf(diarization.backend, ['embedding', 'sortformer'] as const, 'embedding'),
      maxSpeakers: num(diarization.maxSpeakers),
    },
    resample: bool(afe.resample, true),
    normalize: bool(afe.normalize, true),
  };
}

function decoding(parameters: Rec): AsrSpecDecoding {
  const d = rec(parameters.decoding);
  const block: AsrSpecDecoding = {
    languageMode: str(d.languageMode),
    codeSwitching: bool(d.codeSwitching, false),
    wordTimestamps: bool(d.wordTimestamps, false),
    beamSize: num(d.beamSize),
    temperature: num(d.temperature),
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
  return block;
}

function postProcessing(parameters: Rec): AsrSpecPostProcessing {
  const p = rec(parameters.postProcessing);
  return {
    punctuation: { enabled: bool(rec(p.punctuation).enabled, true) },
    disfluency: bool(p.disfluency, false),
    stabilizer: bool(p.stabilizer, false),
    merge: bool(p.merge, false),
  };
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

function instruction(agent: ResolvedAgent): AsrSpecInstruction {
  const i = rec(agent.compiledConfig.instruction);
  const hotwords = Array.isArray(i.hotwords) ? i.hotwords.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];
  return { initialPrompt: str(i.initialPrompt), hotwords };
}

/**
 * TASK-880 — refuse an agent that would re-space diarization.
 *
 * TASK-877 found that the runtime dropped `models.embedding` for every agent (it read
 * only INLINE refs while the spec emits slugs), so the platform singleton always served
 * and nobody had hit this. With the reference actually arriving, an agent binding a
 * 192-d model would write vectors the `vector(256)` `UserVoiceProfile.embedding` column
 * cannot hold — every enrollment fails, at write time, per profile.
 *
 * The check is EVIDENCE-BASED: a row that declares no width cannot be judged, and
 * refusing on absence would make an agent unrunnable over a fact nobody stated. Every
 * SYSTEM catalogue row declares one (`seed/ai-models/audio.ts`), so the undeclared case
 * is a tenant-authored row, where the column itself still rejects a wrong-width vector.
 */
function assertEmbeddingSpace(agent: ResolvedAgent, embedding: AsrSpecModel | undefined): void {
  if (!embedding) return;
  // Read from the AGENT's row, not the spec model: the width is a producer-side
  // invariant and `apps/stt` has no use for it, so it never goes on the wire.
  const declared = num(rec(rec(agent.models.find((m) => m.role === 'embedding')?.metaData).embedding).dimension);
  if (declared === null || declared === VOICE_PROFILE_EMBEDDING_DIMENSION) return;
  throw new AsrSpecBuildError(
    `Agent '${agent.slug}' v${agent.versionNumber} binds speaker-embedding model '${embedding.slug}', which emits ` +
      `${declared}-dimension vectors; enrolled voice profiles are ${VOICE_PROFILE_EMBEDDING_DIMENSION}-dimension ` +
      `(UserVoiceProfile.embedding), so every enrolment and every speaker match on this session would fail. ` +
      `Bind a ${VOICE_PROFILE_EMBEDDING_DIMENSION}-dimension model, or re-enrol the tenant's voice profiles first.`,
    'ASR_AGENT_EMBEDDING_SPACE_MISMATCH',
  );
}

/** One engine chain for `agent`, optionally with its primary ASR model swapped (model-level fallback). */
export function buildAsrSpecCore(agent: ResolvedAgent, override?: { asr: ResolvedAgentModel; runtimeKey: string }): AsrSpecCore {
  const parameters = rec(agent.compiledConfig.parameters);
  const models: AsrSpecModels = { asr: toSpecModel(override?.asr ?? primaryOf(agent), 'asr'), ...auxModels(agent) };
  assertEmbeddingSpace(agent, models.embedding);
  return {
    runtimeKey: override?.runtimeKey ?? agent.agentVersionId,
    agent: { slug: agent.slug, versionId: agent.agentVersionId, versionNumber: agent.versionNumber, tenantId: agent.tenantId, source: agent.source },
    models,
    audioFrontEnd: audioFrontEnd(parameters, models),
    decoding: decoding(parameters),
    postProcessing: postProcessing(parameters),
    streaming: streaming(parameters),
    instruction: instruction(agent),
  };
}

function fallbackOf(agent: ResolvedAgent, fallbackAgent: ResolvedAgent | null | undefined): AsrSpecFallback {
  const f = rec(rec(agent.compiledConfig.parameters).fallback);
  const governance = {
    autoSwitch: bool(f.autoSwitch, AGENT_FALLBACK_DEFAULTS.autoSwitch),
    switchAfterConsecutiveFailures: num(f.switchAfterConsecutiveFailures) ?? AGENT_FALLBACK_DEFAULTS.switchAfterConsecutiveFailures,
  };
  if (fallbackAgent) {
    return { kind: 'agent', ...governance, spec: buildAsrSpecCore(fallbackAgent) };
  }
  const chain = agent.models.filter((m) => m.role === 'fallback').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const first = chain[0];
  if (first) {
    const runtimeKey = `${agent.agentVersionId}:fallback:${first.slug}`;
    return { kind: 'model', ...governance, spec: buildAsrSpecCore(agent, { asr: first, runtimeKey }) };
  }
  return { kind: 'none', ...governance, spec: null };
}

export function buildResolvedAsrSpec(input: BuildResolvedAsrSpecInput): ResolvedAsrSpec {
  const { agent, fallbackAgent } = input;
  if (agent.task !== 'SPEECH_TO_TEXT') {
    throw new AsrSpecBuildError(`Agent '${agent.slug}' is a ${agent.task} agent; an ASR spec needs SPEECH_TO_TEXT.`);
  }
  if (fallbackAgent && fallbackAgent.task !== 'SPEECH_TO_TEXT') {
    throw new AsrSpecBuildError(`Fallback agent '${fallbackAgent.slug}' is a ${fallbackAgent.task} agent; an ASR fallback needs SPEECH_TO_TEXT.`);
  }
  return { schemaVersion: RESOLVED_ASR_SPEC_SCHEMA_VERSION, ...buildAsrSpecCore(agent), fallback: fallbackOf(agent, fallbackAgent) };
}
