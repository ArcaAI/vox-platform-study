/**
 * TASK-879 — the PURE half of TEXT_TO_SPEECH agent resolution, the TTS counterpart of
 * `build-resolved-asr-spec.ts` and `text-generation-spec.ts`.
 *
 * PURE: no I/O, no DI. It folds a TASK-863 `ResolvedAgent` (already tenant-scoped, models already
 * materialised) plus the two facts a repository has to supply — the bound model's `_metadata` and
 * the `AiProviderConnection` row that serves it — into the `ResolvedTtsSpec` (`@arcaai/types`)
 * that travels to `apps/tts` on every synthesis request. Anything needing a repository lives in
 * `TtsAgentResolverService`; anything deciding what the runtime DOES lives here, so the committed
 * contract fixture can pin it.
 *
 * Reference-only rule holds: a candidate carries the engine id, the provider-native model id
 * (`sourceUri`), the local mirror, the deployment artifacts, the selected voice binding and the
 * funding tier DERIVED from the row that serves it — never a credential. The decrypted key rides
 * beside the spec as `provider_overrides`.
 *
 * Defaults policy: a parameter the agent did not set is `null` — the spec carries what the agent
 * SAID. `apps/tts`'s own field defaults remain the single source of engine defaults.
 */
import type {
  AgentFundingTier,
  ResolvedAgent,
  ResolvedAgentModel,
  ResolvedTtsCandidate,
  ResolvedTtsSpec,
  TtsCandidateKind,
  TtsSpecAgent,
  TtsSpecConnection,
  TtsSpecModel,
  TtsSpecParameters,
  TtsVoiceBinding,
} from '@arcaai/types';
import { RESOLVED_TTS_SPEC_SCHEMA_VERSION, TTS_SPEC_MODEL_TASK_TYPE } from '@arcaai/types';
import { effectiveAutoSwitch } from './text-generation-spec';

/** Raised when a resolved agent cannot become a runnable spec (fail closed — never a guessed engine). */
export class TtsSpecBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsSpecBuildError';
  }
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The ENGINE id `apps/tts` registers, and the id the connection plane is keyed by.
 *
 * The contract with the model seed, unchanged from `TenantTtsConfigService.catalogProviderId`
 * (which this replaces): cloud engines carry it on the `provider` column (`azure`, `sarvam`);
 * `built-in` engines declare it as `_metadata.ttsProvider` (`kokoro`, `indic_parler`, `indic_f5`);
 * the slug with `-` → `_` is the last resort.
 */
export function ttsEngineProvider(model: Pick<ResolvedAgentModel, 'provider' | 'slug'>, metaData: unknown): string | null {
  const declared = str(rec(metaData).ttsProvider);
  if (declared) return declared;
  if (model.provider && model.provider !== 'built-in') return model.provider;
  return model.slug ? model.slug.replace(/-/g, '_') : null;
}

/**
 * `AiModel._metadata.voices` normalised to the wire shape. Malformed entries are DROPPED rather
 * than half-read: a voice with no id cannot be selected, and inventing one would put a voice into
 * the catalogue's job without putting it in the catalogue.
 */
export function ttsVoiceBindingsOf(metaData: unknown): TtsVoiceBinding[] {
  const voices = rec(metaData).voices;
  if (!Array.isArray(voices)) return [];
  const out: TtsVoiceBinding[] = [];
  for (const entry of voices) {
    const voice = rec(entry);
    const id = str(voice.id);
    if (!id) continue;
    out.push({
      id,
      locale: str(voice.locale),
      providerVoice: str(voice.providerVoice),
      refAudioPath: str(voice.refAudioPath),
      refText: str(voice.refText),
    });
  }
  return out;
}

/**
 * `AiModel._metadata.artifacts` — the auxiliary deployment paths the loader needs beside the
 * weights (today only the Parler description tokenizer). String values only: a non-string is a
 * malformed row, and forwarding it would only fail deeper inside a loader.
 */
export function ttsArtifactsOf(metaData: unknown): Record<string, string> {
  const artifacts = rec(rec(metaData).artifacts);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    const path = str(value);
    if (path) out[key] = path;
  }
  return out;
}

/** The agent's `parameters` block, normalised. `null` = the agent said nothing. */
export function ttsParametersOf(parameters: unknown): TtsSpecParameters {
  const p = rec(parameters);
  return {
    voice: str(p.voice),
    language: str(p.language),
    speed: num(p.speed),
    format: str(p.format),
    sampleRate: num(p.sampleRate),
    ssml: p.ssml === true,
  };
}

/** The binding `parameters.voice` names on the bound model, or `null` when it names none/an unknown one. */
export function selectTtsVoice(voices: readonly TtsVoiceBinding[], voiceId: string | null | undefined): TtsVoiceBinding | null {
  if (!voiceId) return null;
  return voices.find((voice) => voice.id === voiceId) ?? null;
}

export function primaryTtsModelOf(agent: ResolvedAgent): ResolvedAgentModel | undefined {
  return agent.models.find((entry) => entry.role === 'primary');
}

/** The agent's own `AgentModelFallback` chain, in priority order. */
export function fallbackTtsModelsOf(agent: ResolvedAgent): ResolvedAgentModel[] {
  return agent.models.filter((entry) => entry.role === 'fallback').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** Everything one candidate needs that a repository had to fetch. */
export interface TtsCandidateSource {
  agent: ResolvedAgent;
  model: ResolvedAgentModel;
  kind: TtsCandidateKind;
  /** `AiModel._metadata` for `model`, exactly as stored. */
  metaData?: unknown;
  /** The `AiProviderConnection` row that serves it; `null` when no enabled row answered at either tier. */
  connection?: TtsSpecConnection | null;
  fundingTier: AgentFundingTier;
}

function toSpecAgent(agent: ResolvedAgent): TtsSpecAgent {
  return { slug: agent.slug, versionId: agent.agentVersionId, versionNumber: agent.versionNumber, tenantId: agent.tenantId, source: agent.source };
}

function toSpecModel(model: ResolvedAgentModel, metaData: unknown): TtsSpecModel {
  return {
    role: model.role === 'fallback' ? 'fallback' : 'primary',
    slug: model.slug,
    taskType: TTS_SPEC_MODEL_TASK_TYPE,
    format: model.format,
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? null,
    // Already DERIVED by `AgentResolverService` (TASK-890 §3.11); forwarded verbatim.
    localPath: model.localPath ?? null,
    checksum: model.checksum ?? null,
    computeType: model.computeType ?? null,
    provider: ttsEngineProvider(model, metaData),
    tenantId: model.tenantId,
    artifacts: ttsArtifactsOf(metaData),
    voices: ttsVoiceBindingsOf(metaData),
  };
}

/**
 * One candidate. The runtime key is the agent VERSION id for anything the agent serves as its
 * primary, and a DERIVED key for a model-level fallback over the same agent — two candidates must
 * never share one, or an engine switch is invisible to metrics and metering.
 */
export function toTtsCandidate(source: TtsCandidateSource): ResolvedTtsCandidate {
  const { agent, model, kind } = source;
  const specModel = toSpecModel(model, source.metaData);
  const parameters = ttsParametersOf(agent.compiledConfig.parameters);
  return {
    kind,
    runtimeKey: kind === 'fallback-model' ? `${agent.agentVersionId}:fallback:${model.slug}` : agent.agentVersionId,
    agent: toSpecAgent(agent),
    model: specModel,
    parameters,
    voice: selectTtsVoice(specModel.voices, parameters.voice),
    connection: source.connection ?? null,
    fundingTier: source.fundingTier,
  };
}

/**
 * What a candidate actually DISPATCHES TO: engine, provider-native model id, funding tier, and the
 * endpoint fields of the connection that reaches it. Two candidates sharing this key are the same
 * endpoint however different the agent rows behind them are — and the chain exists to survive an
 * outage, so a second agent binding the same engine behind the same credential is a retry against
 * the dead endpoint the walk is trying to escape.
 *
 * The credential TIER is part of the key on purpose: a tenant's own Azure resource and the
 * platform's Azure account can name the same engine and the same model id and still be different
 * endpoints with different quotas.
 */
function candidateEndpointKey(candidate: ResolvedTtsCandidate): string {
  const connection = candidate.connection;
  return [candidate.model.provider ?? '', candidate.model.sourceUri, candidate.fundingTier, connection?.baseUrl ?? '', connection?.region ?? ''].join(
    '::',
  );
}

export function sameTtsCandidate(a: ResolvedTtsCandidate, b: ResolvedTtsCandidate): boolean {
  if (candidateEndpointKey(a) === candidateEndpointKey(b)) return true;
  // Belt-and-braces for a registry row that carries no engine id at all. `fundingTier` is part of
  // it because two candidates off ONE agent row can still reach two different accounts: a tenant
  // that vetoes nothing and brings its own Azure key is served by its row on the primary and by
  // the platform's on the terminal candidate, and those are not the same endpoint.
  return a.agent.versionId === b.agent.versionId && a.model.slug === b.model.slug && a.fundingTier === b.fundingTier;
}

export interface BuildResolvedTtsSpecInput {
  primary: TtsCandidateSource;
  /** Ordered: the explicit fallback agent | the agent's own model chain, then the platform default. */
  chain: TtsCandidateSource[];
  /** The RAW per-agent toggle — funding-gating is applied here, once, so no consumer re-derives it. */
  autoSwitch: boolean;
}

export function buildResolvedTtsSpec(input: BuildResolvedTtsSpecInput): ResolvedTtsSpec {
  const { primary: primarySource } = input;
  assertTtsAgent(primarySource.agent);
  const primary = toTtsCandidate(primarySource);

  const chain: ResolvedTtsCandidate[] = [];
  for (const source of input.chain) {
    assertTtsAgent(source.agent);
    const candidate = toTtsCandidate(source);
    if (sameTtsCandidate(candidate, primary)) continue;
    if (chain.some((entry) => sameTtsCandidate(entry, candidate))) continue;
    chain.push(candidate);
  }

  return {
    schemaVersion: RESOLVED_TTS_SPEC_SCHEMA_VERSION,
    agent: toSpecAgent(primarySource.agent),
    primary,
    fallback: { autoSwitch: effectiveAutoSwitch(input.autoSwitch, primary.fundingTier), chain },
  };
}

function assertTtsAgent(agent: ResolvedAgent): void {
  if (agent.task !== 'TEXT_TO_SPEECH') {
    throw new TtsSpecBuildError(`Agent '${agent.slug}' is a ${agent.task} agent; a speech spec needs TEXT_TO_SPEECH.`);
  }
}
