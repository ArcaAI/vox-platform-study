/**
 * TASK-879 — `ResolvedTtsSpec`: the fully resolved text-to-speech runtime
 * contract the gateway hands to `apps/tts` on every synthesis request.
 *
 * It REPLACES the `TenantTtsConfig` fold (`routing_en` / `routing_ml` /
 * `allowed_providers` / `voice_bindings`) the three speech entry points used to
 * inject. A capability is an AGENT: the tenant → department → SYSTEM
 * `AgentAssignment` cascade selects a published `TEXT_TO_SPEECH` agent (or an
 * explicit `agentSlug` names one visible to the tenant), and everything the
 * runtime needs to act is in the payload — so `apps/tts` reads no selection from
 * anywhere, exactly as `apps/stt` stopped doing under TASK-861.
 *
 * ONE producer — `buildResolvedTtsSpec()` in `@arcaai/applications`
 * (`services/agent/tts-spec.ts`), fed by TASK-863's `AgentResolverService`. The
 * Python mirror is `apps/tts/src/tts/spec.py`; both sides validate the SAME
 * committed fixture (`tests/contracts/resolved-tts-spec.fixture.json`), which is
 * the cross-language lock.
 *
 * SHAPE: the ASR spec's model/agent blocks with the TEXT lane's ORDERED fallback
 * chain. TTS is per-REQUEST like text generation (no session runtime counts
 * consecutive failures), so there is no `switchAfterConsecutiveFailures` here and
 * `fallback.autoSwitch` is already funding-gated by the resolver — a consumer
 * reads it verbatim and never re-derives funding.
 *
 * CREDENTIALS NEVER TRAVEL HERE. `connection` carries only the NON-SECRET row
 * facts (endpoint, region, timeout) plus the funding tier derived from the row
 * that supplied it; the decrypted key rides beside the spec as
 * `provider_overrides`, exactly as it did before.
 */

import type { AgentFundingTier, ResolvedAgent } from './agent.js';

export const RESOLVED_TTS_SPEC_SCHEMA_VERSION = 1 as const;
export type ResolvedTtsSpecSchemaVersion = typeof RESOLVED_TTS_SPEC_SCHEMA_VERSION;

/** The role a resolved model plays in a TTS chain. */
export const TTS_SPEC_MODEL_ROLES = ['primary', 'fallback'] as const;
export type TtsSpecModelRole = (typeof TTS_SPEC_MODEL_ROLES)[number];

/** The registry `taskType` every model in a TTS spec is loaded under. */
export const TTS_SPEC_MODEL_TASK_TYPE = 'TEXT_TO_SPEECH' as const;

/**
 * One selectable voice on a bound model, resolved from `AiModel._metadata.voices`.
 *
 * `providerVoice` is the vendor/engine-native name when it differs from the
 * catalogue id (`en-female-1` → `af_heart`); `null` means "the id IS the name".
 * `refAudioPath` / `refText` exist for voice-CLONE engines (IndicF5 conditions
 * every synthesis on a reference recording): they are properties of the VOICE,
 * which is why they moved out of `tts.indicF5.{refAudioPath,refText}` and onto
 * the binding the agent's `parameters.voice` selects.
 */
export interface TtsVoiceBinding {
  id: string;
  locale: string | null;
  providerVoice: string | null;
  refAudioPath: string | null;
  refText: string | null;
}

/**
 * One resolved registry row — the fields the `apps/tts` engines consume.
 *
 * `provider` is the ENGINE id `apps/tts` registers and the connection plane is
 * keyed by (`kokoro`, `indic_parler`, `indic_f5`, `azure`, `sarvam`), derived
 * from the row by the documented catalogue cascade
 * (`_metadata.ttsProvider` → the `provider` column when it is not `built-in` →
 * the slug with `-` → `_`). `sourceUri` is the provider-native model id that
 * reaches the wire (`bulbul:v3`, `ai4bharat/indic-parler-tts`).
 *
 * `artifacts` carries the auxiliary deployment paths the loader needs beside the
 * weights — today only `descEncoderPath` (the Parler description tokenizer).
 */
export interface TtsSpecModel {
  role: TtsSpecModelRole;
  slug: string;
  taskType: string;
  format: string;
  sourceUri: string;
  sourceRevision: string | null;
  /**
   * Highest precedence in the loader. DERIVED from `AiModel.bucketPrefix`
   * [+ `primaryObject`] since TASK-890 §3.11 — never a stored column.
   */
  localPath: string | null;
  checksum: string | null;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
  artifacts: Record<string, string>;
  voices: TtsVoiceBinding[];
}

/**
 * The agent's `parameters` block, normalised. `null` means "the agent said
 * nothing", so `apps/tts`'s own field default stands — the spec never restates a
 * runtime default (one source of truth per default).
 */
export interface TtsSpecParameters {
  voice: string | null;
  language: string | null;
  speed: number | null;
  format: string | null;
  sampleRate: number | null;
  ssml: boolean;
}

/**
 * The NON-SECRET half of the `AiProviderConnection` row that serves this
 * candidate: where the provider lives and how long it may take. `null` on a
 * candidate means NO enabled row answered at either tier — for a self-hosted
 * engine that is the platform's "this deployment does not run that engine"
 * (the state `tts.<engine>.enabled` used to hold), and for a cloud provider it
 * is the ordinary keyless state.
 *
 * `funding` is DERIVED from the tier that supplied the row (SYSTEM → `platform`,
 * the caller's own row → `tenant`) and is never stamped by a call site.
 */
export interface TtsSpecConnection {
  provider: string;
  baseUrl: string | null;
  region: string | null;
  timeoutS: number | null;
  funding: AgentFundingTier;
}

/** Which agent version produced a candidate, and how it was chosen. */
export interface TtsSpecAgent {
  slug: string;
  versionId: string;
  versionNumber: number;
  /** The tenant that owns the agent row (the caller's, or SYSTEM for a platform default). */
  tenantId: string;
  source: ResolvedAgent['source'];
}

/** Where a candidate sits in the chain. `platform-default` = the SYSTEM-assigned agent terminating it. */
export type TtsCandidateKind = 'primary' | 'fallback-agent' | 'fallback-model' | 'platform-default';

/**
 * One runnable engine choice. `runtimeKey` is the identity a consumer keys its
 * engine instance, its metrics and its usage rows on — the agent VERSION id for a
 * primary, a derived key for a model-level fallback — and must differ between two
 * candidates so an engine switch is observable.
 */
export interface ResolvedTtsCandidate {
  kind: TtsCandidateKind;
  runtimeKey: string;
  agent: TtsSpecAgent;
  model: TtsSpecModel;
  parameters: TtsSpecParameters;
  /** The binding `parameters.voice` selected on `model.voices`; `null` when it names none. */
  voice: TtsVoiceBinding | null;
  connection: TtsSpecConnection | null;
  fundingTier: AgentFundingTier;
}

export interface ResolvedTtsFallback {
  /**
   * The EFFECTIVE switch decision — already funding-gated, so a consumer reads it
   * verbatim. `false` means "run the primary and stop"; `true` means "walk the chain".
   */
  autoSwitch: boolean;
  /** Ordered: the explicit fallback agent | the agent's own model chain, then the platform default. */
  chain: ResolvedTtsCandidate[];
}

export interface ResolvedTtsSpec {
  schemaVersion: ResolvedTtsSpecSchemaVersion;
  /** The agent the primary came from — the identity a caller logs and meters against. */
  agent: TtsSpecAgent;
  primary: ResolvedTtsCandidate;
  fallback: ResolvedTtsFallback;
}
