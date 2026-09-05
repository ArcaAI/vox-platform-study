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
  /**
   * The EFFECTIVE switch decision — already funding-gated by `effectiveAutoSwitch`, so a consumer
   * reads it verbatim and never re-derives funding of its own. `false` here means "this call runs
   * the primary and stops"; `true` means "walk the chain".
   */
  autoSwitch: boolean;
  /**
   * Ordered: explicit fallback agent | the agent's own model chain, then the platform default.
   *
   * There is no `switchAfterConsecutiveFailures` here, and that is deliberate: both TEXT lanes
   * are per-call (the live flush, and the `core.agent` / `generate` activities) and switch on the
   * FIRST failure of the call they are in, keeping no cross-call state a threshold could count.
   * A threshold belongs to a SESSION-scoped runtime — which is what the ASR block has and this
   * one does not. Owner rule: no dead knobs.
   */
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
 * the PRIMARY candidate and the fallback block, so the harness `core.agent` activity can walk the
 * chain without a second resolution (`api_client.py`).
 *
 * `textPrimary` exists because `ResolvedAgent.fundingTier` is set ONLY for a cloud BYO override —
 * a self-hosted platform primary carries `null` there, while its own fallback candidates carry a
 * DERIVED tier. Shipping the primary as a candidate makes both ends of the chain attributable by
 * the same rule (`row.tenantId === SYSTEM_TENANT_ID`), so metering cannot disagree with itself
 * between the primary attempt and the fallback attempt of one call.
 */
export type ResolvedTextGenerationAgent = ResolvedAgent & { textPrimary: ResolvedTextCandidate; textFallback: ResolvedTextFallback };

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

/**
 * The EFFECTIVE fallback switch for a resolved spec.
 *
 * Owner decision (TASK-870 #4): fallback to the platform default is a PLATFORM HA capability —
 * platform-controlled, metered as platform-funded. A tenant may switch it off only for a primary
 * IT funds (BYO, `fundingTier === 'tenant'`); on a platform-funded primary the toggle is ignored
 * and the chain is always walked, because the tenant is not the party paying for — or bearing the
 * availability of — that generation.
 *
 * Applied ONCE, here, at the resolver's chokepoint: `ResolvedTextFallback.autoSwitch` therefore
 * carries the answer, not the raw toggle, and no runtime lane has to re-derive funding to obey it.
 */
export function effectiveAutoSwitch(toggle: boolean, primaryFunding: AgentFundingTier): boolean {
  return toggle || primaryFunding !== 'tenant';
}

/**
 * What a candidate actually DISPATCHES TO: provider, provider-native model, and the credential
 * that reaches it (its funding tier, plus the one-hop override's endpoint fields). Two candidates
 * sharing this key are the same endpoint, however different the agent rows behind them are.
 *
 * The credential is part of the key on purpose: a tenant's own Azure deployment and the
 * platform's Azure account can name the same provider and the same model id and still be
 * different endpoints with different quotas — falling back from one to the other is real HA, not
 * a retry.
 */
function candidateEndpointKey(candidate: ResolvedTextCandidate): string {
  const override = candidate.providerOverride;
  return [candidate.provider, candidate.model, candidate.fundingTier, override?.base_url ?? '', override?.deployment_name ?? ''].join('::');
}

/**
 * Two candidates are the same runnable thing when they would dispatch to the same ENDPOINT — not
 * merely when they come from the same agent row.
 *
 * The chain exists to survive a provider outage, so a second agent that happens to bind the same
 * provider + model id behind the same credential is a retry against the dead endpoint the walk is
 * trying to escape. (The agent-version + model-slug equality is kept as a belt-and-braces case
 * for a registry row that carries no provider.)
 */
export function sameCandidate(a: ResolvedTextCandidate, b: ResolvedTextCandidate): boolean {
  if (candidateEndpointKey(a) === candidateEndpointKey(b)) return true;
  return a.agent.versionId === b.agent.versionId && a.modelSlug === b.modelSlug;
}
