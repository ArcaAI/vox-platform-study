/**
 * TASK-876 — the resolved TEXT_GENERATION contract, the text counterpart of `ResolvedAsrSpec`.
 *
 * PURE: no I/O, no DI. `TextAgentResolverService` folds a TASK-863 `ResolvedAgent` (already
 * tenant-scoped, models already materialised) into ONE primary candidate plus an ORDERED
 * fallback chain; the helpers here decide what a candidate IS so the runtime lanes (the live
 * loop, the Temporal `core.agent` activity, every `resolveTextSelection` caller) read one shape.
 *
 * Reference-only rule holds: a candidate carries the model's provider-native id (`sourceUri`),
 * the provider name apps/text registers, the agent's resolved instruction and parameters, and
 * the funding tier DERIVED from the row that serves it — never a credential of its own beyond
 * the one-hop `providerOverride` the agent resolver already produces.
 */
import type { AgentCompiledConfig, AgentFundingTier, ResolvedAgent, ResolvedAgentModel, ResolvedAgentProviderOverride } from '@arcaai/types';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';

export const RESOLVED_TEXT_SPEC_SCHEMA_VERSION = 1 as const;

/** Where a candidate sits in the chain. `platform-default` = the SYSTEM-assigned agent terminating it. */
export type TextCandidateKind = 'primary' | 'fallback-agent' | 'fallback-model' | 'platform-default';

export interface ResolvedTextCandidate {
  kind: TextCandidateKind;
  agent: {
    slug: string;
    versionId: string;
    versionNumber: number;
    /** The tenant that OWNS the agent row (SYSTEM for the platform default). */
    tenantId: string;
    source: ResolvedAgent['source'];
  };
  modelSlug: string;
  /** The provider as apps/text registers it (`azure` → `azure-openai`). */
  provider: string;
  /** The provider-native model id (`AiModel.sourceUri`) — what actually goes on the wire. */
  model: string;
  resolvedPrompt: AgentCompiledConfig['resolvedPrompt'];
  instruction: Record<string, unknown> | null;
  parameters: Record<string, unknown>;
  tools: AgentCompiledConfig['tools'];
  /** DERIVED from the row that serves this candidate — never stamped by a call site. */
  fundingTier: AgentFundingTier;
  /** The one-hop cloud credential for `provider`, when a tier holds one. Never persisted. */
  providerOverride?: ResolvedAgentProviderOverride;
}

export interface ResolvedTextFallback {
  /** The tenant's per-agent HA toggle (`parameters.fallback.autoSwitch`, default ON). Carried, never decided here. */
  autoSwitch: boolean;
  switchAfterConsecutiveFailures: number;
  /** Ordered: explicit fallback agent | the agent's own model chain, then the platform default. */
  chain: ResolvedTextCandidate[];
}

export interface ResolvedTextGenerationSpec {
  schemaVersion: typeof RESOLVED_TEXT_SPEC_SCHEMA_VERSION;
  /** The agent the primary came from, exactly as `AgentResolverService.resolve` returned it. */
  agent: ResolvedAgent;
  primary: ResolvedTextCandidate;
  fallback: ResolvedTextFallback;
}

/**
 * What the internal resolve route returns for a TEXT_GENERATION agent: the TASK-863 shape plus
 * the fallback block, so the harness `core.agent` activity can walk the chain without a second
 * resolution (`api_client.py`).
 */
export type ResolvedTextGenerationAgent = ResolvedAgent & { textFallback: ResolvedTextFallback };

/** The catalog seeds `azure`; apps/text registers `azure-openai`. The connection plane stays keyed by `azure`. */
export function textWireProvider(provider: string): string {
  return provider === 'azure' ? 'azure-openai' : provider;
}

/**
 * Funding for a candidate served by NO provider connection (a self-hosted model) is a pure
 * function of WHOSE agent row serves it — the same rule `AiRoutingPolicyService.fundRow`
 * applies to a routing row without a connection: SYSTEM → platform, anything else → tenant.
 */
export function fundingOfAgentRow(agent: Pick<ResolvedAgent, 'tenantId'>): AgentFundingTier {
  return agent.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant';
}

export function primaryModelOf(agent: ResolvedAgent): ResolvedAgentModel | undefined {
  return agent.models.find((entry) => entry.role === 'primary');
}

/** The agent's own `AgentModelFallback` chain, in priority order. */
export function fallbackModelsOf(agent: ResolvedAgent): ResolvedAgentModel[] {
  return agent.models.filter((entry) => entry.role === 'fallback').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

export interface CandidateFunding {
  fundingTier: AgentFundingTier;
  providerOverride?: ResolvedAgentProviderOverride;
}

/** One candidate from an agent + one of its materialised models. `null` when the model has no provider-native id. */
export function toTextCandidate(
  agent: ResolvedAgent,
  model: ResolvedAgentModel,
  kind: TextCandidateKind,
  funding: CandidateFunding,
): ResolvedTextCandidate | null {
  if (!model.sourceUri) return null;
  const compiled = agent.compiledConfig;
  return {
    kind,
    agent: { slug: agent.slug, versionId: agent.agentVersionId, versionNumber: agent.versionNumber, tenantId: agent.tenantId, source: agent.source },
    modelSlug: model.slug,
    provider: textWireProvider(model.provider ?? 'local'),
    model: model.sourceUri,
    resolvedPrompt: compiled.resolvedPrompt ?? null,
    instruction: compiled.instruction ?? null,
    parameters: compiled.parameters ?? {},
    tools: compiled.tools ?? [],
    fundingTier: funding.fundingTier,
    ...(funding.providerOverride ? { providerOverride: funding.providerOverride } : {}),
  };
}

/** Two candidates are the same runnable thing when they run the same agent version on the same model. */
export function sameCandidate(a: ResolvedTextCandidate, b: ResolvedTextCandidate): boolean {
  return a.agent.versionId === b.agent.versionId && a.modelSlug === b.modelSlug;
}
