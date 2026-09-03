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

/** The role a resolved model plays in the agent's chain. */
export type ResolvedAgentModelRole = 'primary' | 'fallback' | 'vad' | 'denoise' | 'embedding' | 'punctuation';

export interface ResolvedAgentModel {
  role: ResolvedAgentModelRole;
  /** Chain position for `fallback` roles (0 = first fallback); `undefined` otherwise. */
  priority?: number;
  slug: string;
  sourceUri: string;
  sourceRevision: string | null;
  localPath: string | null;
  checksum: string | null;
  format: string;
  computeType: string | null;
  provider: string | null;
  /** The tenant that OWNS the registry row (SYSTEM for the platform catalogue). */
  tenantId: string;
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
  resolvedPrompt: { source: 'template'; promptTemplateId: string; promptVersionNumber: number; content: string } | { source: 'inline'; content: string } | null;
  parameters: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tools: Array<{ mcpServerId: string; toolName: string }>;
  protocols: Array<'http' | 'http-sse' | 'socket'>;
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
}
