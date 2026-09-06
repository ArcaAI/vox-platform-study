/**
 * TASK-863 — the resolved-agent contract shared by the gateway (standalone
 * invocation, STT sessions — TASK-861), the harness `core.agent` activity
 * (TASK-864, over `GET /internal/agents/resolve`) and the SDKs (TASK-865).
 *
 * `AgentResolverService.resolve()` in `@arcaai/applications` is the ONE
 * producer; every field is a fully resolved REFERENCE plus what a runtime
 * needs to act on it — never a credential. Provider credentials travel as a
 * `providerOverride` wire entry whose `api_key` the gateway decrypts only for
 * the hop to the Python service.
 */

export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';

/** Which tier supplied the provider credential — decides BYOK vs CLOUD metering (derived, never stamped). */
export type AgentFundingTier = 'tenant' | 'platform';

/**
 * The role a resolved model plays in the agent's chain.
 *
 * TASK-880 added `endpointing`, which TASK-877 shipped on the ASR wire
 * (`ASR_SPEC_MODEL_ROLES`) and in the committed contract fixture without ever
 * declaring here — so the one role a `ResolvedAgent` could legitimately carry was
 * the one this union rejected.
 */
export type ResolvedAgentModelRole = 'primary' | 'fallback' | 'vad' | 'denoise' | 'embedding' | 'punctuation' | 'endpointing';

/**
 * The `AiModel._metadata` facts a RUNTIME needs, narrowed to what it may act on.
 *
 * TASK-880 — model-coupled geometry stops being a platform settings key and becomes a
 * property of the row that owns it, so the fallback engine gets ITS OWN numbers instead of
 * the primary's. Only the declared members travel; the rest of `_metadata` (voice
 * catalogues, label taxonomies, hub artifacts) is for other planes and is never forwarded.
 */
export interface ResolvedAgentModelMetadata {
  /** ASR decode geometry — replaces `stt.whisperCpp.maxAudioSeconds` / `stt.streaming.partialWindowS`. */
  asr?: {
    /** Longest audio fed to the engine in ONE decode, seconds. Absent ⇒ the engine's own default. */
    maxDecodeWindowSec?: number;
    /** Tail window of the live utterance decoded for PARTIALs, seconds. Absent ⇒ the preprocessor default. */
    partialWindowSec?: number;
  };
  /**
   * Speaker-embedding geometry. `dimension` is the vector width the row emits, and it must
   * match the deployed `UserVoiceProfile.embedding` column or every enrollment fails — which
   * is why `buildResolvedAsrSpec` REFUSES a mismatch rather than shipping a spec that cannot
   * enroll (TASK-880; the defect TASK-877 recorded and deferred).
   */
  embedding?: { dimension?: number };
}

export interface ResolvedAgentModel {
  role: ResolvedAgentModelRole;
  /** Chain position for `fallback` roles (0 = first fallback); `undefined` otherwise. */
  priority?: number;
  slug: string;
  sourceUri: string;
  sourceRevision: string | null;
  /**
   * Where the weights are, for a service that loads them itself.
   *
   * DERIVED (TASK-890 §3.11), never a stored column: `/mnt/models-bucket/` +
   * `AiModel.bucketPrefix` [+ `primaryObject`], computed by `derivedLocalPath`
   * at resolve time. `null` when the row has no bucket identity, which is the
   * signal for the consumer to fall back to `sourceUri` scheme dispatch. The
   * WIRE contract is unchanged — `apps/stt` still reads `local_path` as the
   * highest-precedence weight location.
   */
  localPath: string | null;
  /**
   * The provider-native id that goes ON THE WIRE for a vendor/engine call
   * (`AiModel.wireModelId`), as opposed to `sourceUri`, which is the row's
   * LOCATOR (HF repo, `s3://`). Null on a row that has not declared one yet.
   */
  wireModelId: string | null;
  checksum: string | null;
  format: string;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
  /** The narrow `AiModel._metadata` slice a runtime may act on; absent when the row declares none. */
  metaData?: ResolvedAgentModelMetadata | null;
}

/**
 * The per-provider wire entry the Python services already accept under
 * `provider_overrides` (`ProviderOverrideEntry` in `@arcaai/applications`).
 * `api_key` is the DECRYPTED credential and must never be persisted or logged.
 */
export interface ResolvedAgentProviderOverride {
  provider: string;
  api_key: string;
  funding: AgentFundingTier;
  base_url?: string;
  region?: string;
  api_version?: string;
  deployment_name?: string;
  [extra: string]: string | undefined;
}

/**
 * What `compiledConfig` carries once published — the fully resolved references
 * the runtime consumes. Stamped by `AgentService.publish`, never from a DTO.
 */
export interface AgentCompiledConfig {
  task: AgentTask;
  /** `AiProviderConnection.service` the credential resolves under (`stt` | `llm` | `tts`). */
  service: 'stt' | 'llm' | 'tts';
  model: { id: string; slug: string; provider: string | null; taskType: string };
  fallbacks: Array<{ priority: number; id: string; slug: string; provider: string | null }>;
  instruction: Record<string, unknown> | null;
  /** The resolved prompt text when the instruction is template-bound (pinned version), else the inline system prompt. */
  resolvedPrompt:
    { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string } | { source: 'inline'; content: string } | null;
  parameters: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tools: Array<{ mcpServerId: string; toolName: string }>;
  protocols: Array<'http' | 'http-sse' | 'socket'>;
  /**
   * TASK-890 §3.14 (OD-R) — the AGENT tier of the guardrail opt-out, stamped at publish from
   * `parameters.guards.enabled ?? true`.
   *
   * ADDITIVE-OPTIONAL on purpose: every artifact published before this ticket carries no such
   * key, and absence must read as ON. It is the BOTTOM of `resolveGuardrailDecision`'s
   * precedence (node > workflow > agent > on) — a workflow node may override it in either
   * direction, and nothing here can turn screening on that the PLATFORM turned off.
   */
  guardrail?: { enabled: boolean };
}

export interface ResolvedAgent {
  agentId: string;
  /** The version row that resolved (same as `agentId` — rows are versions; kept distinct for TASK-864 pinning). */
  agentVersionId: string;
  slug: string;
  versionNumber: number;
  task: AgentTask;
  /** The tenant that owns the resolved row (the caller's, or SYSTEM for a platform default). */
  tenantId: string;
  /** How the row was chosen. */
  source: 'explicit' | 'department' | 'tenant' | 'platform-default';
  compiledConfig: AgentCompiledConfig;
  models: ResolvedAgentModel[];
  providerOverride?: ResolvedAgentProviderOverride;
  fundingTier?: AgentFundingTier;
  /**
   * TASK-890 §3.14 — the agent's guardrail decision, RESOLVED (never optional here).
   *
   * `compiledConfig.guardrail` is additive-optional because old artifacts predate it; this is
   * not, because every consumer needs an answer rather than a maybe. `AgentResolverService`
   * normalises absence — and any malformed value — to `{ enabled: true }`: on a safety gate,
   * "unparseable" must read as SCREENED, never as an opt-out.
   *
   * Consumed by the invocation path, the realtime `core.agent` lane and the harness over
   * `GET /internal/agents/resolve`, each of which pushes it to TEXT as
   * `guardrail_policy.enabled` after folding any node / workflow opinion over it.
   */
  guardrail: { enabled: boolean };
}
