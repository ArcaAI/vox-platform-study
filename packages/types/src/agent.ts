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

import type { AiModelAsrProfile } from './asr-model-profile.js';

export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

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
  /**
   * The ASR decode profile the row carries — TASK-880's two window members, widened by
   * TASK-934 into the full `AiModelAsrProfile` (decode knobs + priming prompt) so the
   * parameters a fine-tune was MEASURED with travel with its weights.
   *
   * Declared here as the profile TYPE and nowhere else: `buildResolvedAsrSpec` reads it
   * through `parseAiModelAsrProfile`, which is the range/unknown-key gate, because the
   * underlying `_metadata` is admin-editable JSON and this interface is only a claim.
   */
  asr?: AiModelAsrProfile;
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
  /**
   * `AiModel.libraryName` — the Hugging Face `library_name` facet and, since
   * TASK-860, THE loader-selection field (`format` beside it is descriptive).
   *
   * TASK-944 (B2): optional so every existing construction site keeps compiling
   * and a consumer that predates it is unaffected; `toResolvedModel` always sets
   * it from the NOT NULL column, so a production spec always carries it. Absent
   * means the sender predates the field, and `apps/stt` falls back to `format` —
   * which is the pre-TASK-860 key that could not tell a pyannote checkpoint from
   * a transformers one, because both are `PYTORCH`.
   */
  libraryName?: string;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
  /**
   * TASK-958 D-3 — the `AiProviderConnection` this row was DECLARED on ("the model
   * row names the connection"), the FK TASK-890 already wrote at declaration time.
   *
   * It is the binding a tenant admin actually makes: a tenant may hold several
   * connections for one `(service, provider)`, so the provider NAME names a GROUP
   * of accounts and can no longer select a credential. Present ⇒ THAT connection
   * serves or the candidate fails closed; `null`/absent ⇒ a SYSTEM catalogue row,
   * which resolves through the tenant's DEFAULT connection exactly as before.
   *
   * ADDITIVE-OPTIONAL, and omitted rather than nulled by `AgentResolverService`:
   * this shape crosses the wire to the harness (`GET /internal/agents/resolve`),
   * so a field one half has not learned yet has to be able to be missing.
   */
  sourceConnectionId?: string | null;
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
 * TASK-947 — one fragment of a composite instruction, frozen at publish. `when` is the authored
 * CEL condition (`null` = always included), evaluated at render time over the same scope the
 * content renders against.
 */
export interface AgentCompiledPromptFragment {
  key: string;
  source: 'template' | 'inline';
  promptTemplateId?: string;
  promptVersionNumber?: number;
  content: string;
  when: string | null;
}

/**
 * What `compiledConfig` carries once published — the fully resolved references
 * the runtime consumes. Stamped by `AgentService.publish`, never from a DTO.
 */
export interface AgentCompiledConfig {
  task: AgentTask;
  /**
   * `AiProviderConnection.service` the credential resolves under (`stt` | `llm` | `tts`).
   *
   * TASK-930 — `null` for a NAMED_ENTITY_RECOGNITION agent (and for any model whose registry
   * task type maps to no provider service): token classification is served by `apps/nlp` from
   * platform-hosted weights, so there is no credential tier to resolve and a runtime must SKIP
   * the provider-override lookup rather than pick a service that does not apply.
   */
  service: 'stt' | 'llm' | 'tts' | null;
  model: { id: string; slug: string; provider: string | null; taskType: string };
  fallbacks: Array<{ priority: number; id: string; slug: string; provider: string | null }>;
  instruction: Record<string, unknown> | null;
  /**
   * The resolved prompt text when the instruction is template-bound (pinned version), else the
   * inline system prompt — or, since TASK-947, the COMPOSITE: every fragment's content frozen at
   * publish beside its authored `when`, with `content` holding the STATIC PROJECTION (the
   * unconditional fragments joined) so a reader that predates fragments still serves the base
   * prompt (OD-3). The selection + render algorithm is `composePrompt` in
   * `@arcaai/workflow-contract`, mirrored by the harness and pinned by
   * `tests/contracts/prompt-composition.fixture.json`.
   */
  resolvedPrompt:
    | { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string }
    | { source: 'inline'; content: string }
    | { source: 'composite'; content: string; join: string; fragments: AgentCompiledPromptFragment[] }
    | null;
  parameters: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tools: Array<{ mcpServerId: string; toolName: string }>;
  // TASK-983 OD-6 — `protocols` (a static per-task constant, `AGENT_PROTOCOLS[task]`) was REMOVED
  // here: no reader ever enforced it — the gateway's one real mode refusal (`?mode=stream` on a
  // NAMED_ENTITY_RECOGNITION agent) is hand-written in `AgentController.invokeNer`, not driven by
  // this field. Rows published before this ticket still carry `compiledConfig.protocols` in the
  // database; nothing here reads it, so the extra key is harmless.
  // See `docs/operations/deprecation-register.md` §SDK.
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
  /**
   * TASK-890 §3.4 — the context schema this agent PINS, frozen at publish.
   *
   * The runtime NEVER re-reads the schema row: `payloadSchema` is
   * `payloadSchemaFromDefinition(version.definition)` as it stood when the agent was published,
   * so an invocation is validated against the contract the author saw. ADDITIVE-OPTIONAL — an
   * agent that pins nothing carries no key, and every artifact published before this ticket
   * carries none either.
   */
  contextSchema?: { schemaId: string; versionNumber: number; versionId: string; payloadSchema: Record<string, unknown> } | null;
}

export interface ResolvedAgent {
  agentId: string;
  /** The version row that resolved (same as `agentId` — rows are versions; kept distinct for TASK-864 pinning). */
  agentVersionId: string;
  slug: string;
  versionNumber: number;
  task: AgentTask;
  /** The tenant that owns the resolved row — always the CALLER's after TASK-890 L13. */
  tenantId: string;
  /**
   * How the row was chosen.
   *
   * TASK-890 OD-M — `platform-default` is gone: an agent is CONTENT (§1.5), so SYSTEM is the
   * reference set a tenant is PROVISIONED from and never a tier resolved through at runtime. A
   * platform agent reaches a tenant as the tenant's own clone (`sourceTenantId = SYSTEM`), which
   * resolves through the `tenant` tier like any other row.
   */
  source: 'explicit' | 'department' | 'tenant';
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
