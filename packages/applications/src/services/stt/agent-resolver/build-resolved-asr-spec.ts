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
  AsrSpecModelRole,
  AsrSpecModels,
  AsrSpecPostProcessing,
  AsrSpecStreaming,
  ResolvedAgent,
  ResolvedAgentModel,
  ResolvedAsrSpec,
} from '@arcaai/types';
import { ASR_SPEC_ROLE_TASK_TYPE, RESOLVED_ASR_SPEC_SCHEMA_VERSION } from '@arcaai/types';

/** The former `STT_FALLBACK_DEFAULTS` of `TenantSttConfig`, now the agent's `fallback` block defaults. */
export const ASR_SPEC_FALLBACK_DEFAULTS = Object.freeze({ autoSwitch: true, switchAfterConsecutiveFailures: 2 });

/** Raised when a resolved agent cannot become a runnable spec (fail closed — never a guessed engine). */
export class AsrSpecBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrSpecBuildError';
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

function toSpecModel(model: ResolvedAgentModel, role: AsrSpecModelRole): AsrSpecModel {
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
  };
}

function primaryOf(agent: ResolvedAgent): ResolvedAgentModel {
  const primary = agent.models.find((m) => m.role === 'primary');
  if (!primary) throw new AsrSpecBuildError(`Agent '${agent.slug}' v${agent.versionNumber} resolved no primary ASR model.`);
  return primary;
}

function auxModels(agent: ResolvedAgent): Omit<AsrSpecModels, 'asr'> {
  const out: Omit<AsrSpecModels, 'asr'> = {};
  for (const role of ['vad', 'denoise', 'embedding', 'punctuation'] as const) {
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
  return {
    vad: { enabled: true, threshold: num(vad.threshold), minSpeechMs: num(vad.minSpeechMs), minSilenceMs: num(vad.minSilenceMs) },
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
  return {
    languageMode: str(d.languageMode),
    codeSwitching: bool(d.codeSwitching, false),
    wordTimestamps: bool(d.wordTimestamps, false),
    beamSize: num(d.beamSize),
    temperature: num(d.temperature),
    vadFilter: bool(d.vadFilter, false),
  };
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
  return {
    partialIntervalMs: num(s.partialIntervalMs),
    endpointing: oneOf(s.endpointing, ['fixed', 'semantic'] as const, 'fixed'),
    maxUtteranceSec: num(s.maxUtteranceSec),
  };
}

function instruction(agent: ResolvedAgent): AsrSpecInstruction {
  const i = rec(agent.compiledConfig.instruction);
  const hotwords = Array.isArray(i.hotwords) ? i.hotwords.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];
  return { initialPrompt: str(i.initialPrompt), hotwords };
}

/** One engine chain for `agent`, optionally with its primary ASR model swapped (model-level fallback). */
export function buildAsrSpecCore(agent: ResolvedAgent, override?: { asr: ResolvedAgentModel; runtimeKey: string }): AsrSpecCore {
  const parameters = rec(agent.compiledConfig.parameters);
  const models: AsrSpecModels = { asr: toSpecModel(override?.asr ?? primaryOf(agent), 'asr'), ...auxModels(agent) };
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
    autoSwitch: bool(f.autoSwitch, ASR_SPEC_FALLBACK_DEFAULTS.autoSwitch),
    switchAfterConsecutiveFailures: num(f.switchAfterConsecutiveFailures) ?? ASR_SPEC_FALLBACK_DEFAULTS.switchAfterConsecutiveFailures,
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
