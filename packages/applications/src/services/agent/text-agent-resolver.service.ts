import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { canonicalAgentTags, readAgentFallbackGovernance } from '@arcaai/workflow-contract';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { ProviderCredentialResolver } from '../ai-provider-connection/provider-credential-resolver';
import { ProviderVetoedException } from '../ai-provider-connection/provider-vetoed.exception';
import { AgentResolverService } from './agent-resolver.service';
import {
  RESOLVED_TEXT_SPEC_SCHEMA_VERSION,
  effectiveAutoSwitch,
  fallbackModelsOf,
  fundingOfAgentRow,
  primaryModelOf,
  sameCandidate,
  toTextCandidate,
  type CandidateFunding,
  type ResolvedTextCandidate,
  type ResolvedTextGenerationSpec,
  type TextCandidateKind,
} from './text-generation-spec';

export interface ResolveTextSpecInput {
  tenantId: string;
  /** Explicit agent (lineage slug). Absent ⇒ the `AgentAssignment` cascade for `TEXT_GENERATION`. */
  agentSlug?: string | null;
  /**
   * A version PIN (`core.agent.agentRef.versionNumber`). The resolver serves the ACTIVE published
   * version and takes no pin, so honouring one means REFUSING a different version — a pin that
   * ran whatever is active would be no pin at all. Fails CLOSED (409), as the Temporal lane does.
   */
  versionNumber?: number | null;
  departmentId?: string | null;
  /**
   * TASK-884 selector tags for the cascade. TASK-891 uses ONE reserved key — `phase:live` /
   * `phase:finalize` / `phase:test`, minted by `textPhaseSelectorTags` — so the live flush and
   * the finalize synthesis can resolve DIFFERENT agents of the same tenant and task, which is
   * the only way one tenant expresses two reasoning postures.
   *
   * Part of the cache key (see `specCache`), and omitted from the downstream call when empty.
   */
  selectorTags?: readonly string[];
}

/**
 * TASK-876 — the ONE resolution from "generate text for tenant T" to a runnable
 * `ResolvedTextGenerationSpec`, the TEXT_GENERATION counterpart of `AsrAgentResolverService`:
 *
 *  1. explicit `agentSlug` → a PUBLISHED, ACTIVE `TEXT_GENERATION` agent visible to the tenant,
 *     else the `AgentAssignment` cascade `department → tenant → SYSTEM` — both through
 *     TASK-863's `AgentResolverService`, which owns the 404-over-403 posture;
 *  2. the ORDERED fallback chain (owner decision #4 — fallback is a platform HA capability, ON
 *     by default, to the platform default): the agent's `parameters.fallback.agentSlug` when
 *     it names one (kind `fallback-agent`), else the agent's own `AgentModelFallback` chain
 *     (kind `fallback-model`); and ALWAYS the SYSTEM-assigned agent of the same task as the
 *     terminal `platform-default` unless the primary already is it. A fallback that will not
 *     resolve DEGRADES to the next option — resilience configuration never blocks the primary;
 *  3. `autoSwitch` is emitted as the EFFECTIVE value, not the raw toggle: fallback is a platform
 *     HA capability, so a tenant may disable it only for a primary it FUNDS (BYO). On a
 *     platform-funded primary the toggle is IGNORED and the chain is always walked. This class
 *     is the single chokepoint for that rule — every consumer (the live loop, the harness
 *     activity, `resolveTextFallbackSelection`) reads `fallback.autoSwitch` verbatim and must
 *     never re-derive funding to second-guess it;
 *  4. every cloud candidate gets its credential from TASK-862's `ProviderCredentialResolver`
 *     (`llm`, provider, tenant) with its funding tier derived from the row that served IT; a
 *     self-hosted candidate is funded by whose agent row serves it (SYSTEM → platform). A veto
 *     or entitlement refusal on the PRIMARY propagates (fail closed); on a FALLBACK it leaves
 *     that candidate out of the chain, so a tenant that vetoed one provider still generates on
 *     another. A backend fault propagates — never disguised as "no credential".
 *
 * Replaces, for every text caller: `AiTaskDefaultService.getEffective('text.*')`,
 * `HarnessPolicy.textProvider/textModel`, a node's `llmBinding`, and the frozen `liveLlm`.
 */
/**
 * How long a resolved spec may be reused. Short on purpose: the live loop flushes every few
 * seconds, so this collapses a burst of flushes into ONE resolution while keeping the worst-case
 * staleness of an agent publish, an `AgentAssignment` write or a credential rotation to seconds.
 */
export const TEXT_SPEC_CACHE_TTL_MS = 15_000;

/** Bound on distinct keys held per process (tenant × department × explicit slug). */
const TEXT_SPEC_CACHE_MAX_ENTRIES = 500;

@Injectable()
export class TextAgentResolverService {
  private readonly logger = new Logger(TextAgentResolverService.name);

  /**
   * Per-process, TTL-only cache of `resolve()`.
   *
   * WHY: a live flush resolved the whole spec from scratch — the assignment cascade, the agent
   * row and its models, the prompt, the platform-default agent, and a credential per cloud
   * candidate — roughly ten round trips, four times per flush on the live documentation lane.
   *
   * KEYED BY `tenantId::departmentId::agentSlug`. **`tenantId` leads and is never optional**
   * (rule 09 §Config caches M1): a cache keyed by anything less serves one tenant's agent — and
   * one tenant's credential — to another. A version PIN is deliberately NOT in the key: the pin
   * is enforced AFTER resolution against the cached spec's `versionNumber`, so a pinned call
   * still fails closed on drift while sharing the entry.
   *
   * TTL-ONLY, and that is a decision, not an omission: no invalidation channel in this monorepo
   * covers an agent publish or an `AgentAssignment` write (`app-settings:invalidate` carries
   * `GlobalSetting` writes, `arca:secrets:invalidate` carries secret rotations; neither is
   * published by `AgentService.publish` or the assignment writer). Wiring one is a follow-on;
   * until then the TTL above is the whole propagation bound — including for a rotated cloud
   * credential carried on a candidate's one-hop `providerOverride`.
   *
   * Entries are cloned on read so a consumer cannot mutate another caller's spec.
   */
  private readonly specCache = new Map<string, { expiresAt: number; spec: ResolvedTextGenerationSpec }>();
  /** In-flight resolutions, so concurrent flushes share ONE round trip instead of racing. */
  private readonly inFlight = new Map<string, Promise<ResolvedTextGenerationSpec>>();

  constructor(
    private readonly agents: AgentResolverService,
    @Inject(IAgentAssignmentService) private readonly assignments: IAgentAssignmentServicePort,
    // Optional so positional test construction and a stack without TASK-862's resolver still
    // work: the agent resolver's own `providerOverride` then serves the primary.
    @Optional() private readonly credentials?: ProviderCredentialResolver,
  ) {}

  async resolve(input: ResolveTextSpecInput): Promise<ResolvedTextGenerationSpec> {
    const { tenantId } = input;
    // TASK-891 — the SELECTOR is part of the key. Without it the 15 s window would let the
    // first flush's spec answer every phase behind it, which is exactly the cross-tier bleed
    // the phase tag exists to remove. Canonicalised so `{a,b}` and `{b,a}` share one entry.
    const selector = canonicalAgentTags([...(input.selectorTags ?? [])]).join(',');
    const key = `${tenantId}::${input.departmentId ?? ''}::${input.agentSlug ?? ''}::${selector}`;
    const spec = await this.cached(key, tenantId, input);
    // Enforced on the CACHED spec, so a pinned call shares the entry and still fails CLOSED.
    if (typeof input.versionNumber === 'number' && spec.agent.versionNumber !== input.versionNumber) {
      throw new ConflictException({
        code: 'AGENT_VERSION_DRIFT',
        message: `Agent '${spec.agent.slug}' is pinned to v${input.versionNumber} but the active published version is v${spec.agent.versionNumber}.`,
      });
    }
    return spec;
  }

  /** The cache + single-flight wrapper around one full resolution. Errors are never cached. */
  private async cached(key: string, tenantId: string, input: ResolveTextSpecInput): Promise<ResolvedTextGenerationSpec> {
    const now = Date.now();
    const hit = this.specCache.get(key);
    if (hit && hit.expiresAt > now) return structuredClone(hit.spec);
    if (hit) this.specCache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending);

    const work = (async () => {
      const agent = await this.agents.resolve({
        tenantId,
        task: AgentTask.TEXT_GENERATION,
        agentSlug: input.agentSlug ?? null,
        departmentId: input.departmentId ?? null,
        // Absent, not empty, when there is nothing to say — see `ResolveAgentInput.selectorTags`.
        ...(input.selectorTags?.length ? { selectorTags: input.selectorTags } : {}),
      });
      return this.resolveFromAgent(agent, tenantId);
    })();
    this.inFlight.set(key, work);
    try {
      const spec = await work;
      this.pruneCache(now);
      this.specCache.set(key, { expiresAt: Date.now() + TEXT_SPEC_CACHE_TTL_MS, spec });
      return structuredClone(spec);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Drop expired entries, then the oldest, so a long-lived process cannot grow this map without bound. */
  private pruneCache(now: number): void {
    for (const [key, entry] of this.specCache) {
      if (entry.expiresAt <= now) this.specCache.delete(key);
    }
    while (this.specCache.size >= TEXT_SPEC_CACHE_MAX_ENTRIES) {
      const oldest = this.specCache.keys().next();
      if (oldest.done) break;
      this.specCache.delete(oldest.value);
    }
  }

  /** The chain for an agent the caller already resolved (the internal resolve route, which must not resolve twice). */
  async resolveFromAgent(agent: ResolvedAgent, tenantId: string): Promise<ResolvedTextGenerationSpec> {
    if (agent.task !== AgentTask.TEXT_GENERATION) {
      throw new BadRequestException(`Agent '${agent.slug}' is a ${agent.task} agent; a text-generation spec needs TEXT_GENERATION.`);
    }
    const primaryModel = primaryModelOf(agent);
    const primary = primaryModel ? await this.candidate(agent, primaryModel, 'primary', tenantId) : null;
    if (!primary) {
      throw new ConflictException({
        code: 'TEXT_AGENT_UNRUNNABLE',
        message: `Agent '${agent.slug}' v${agent.versionNumber} binds no runnable primary model (no provider-native model id); republish it on a registered model.`,
      });
    }

    const governance = readAgentFallbackGovernance(agent.compiledConfig.parameters);
    const chain: ResolvedTextCandidate[] = [];
    const push = (candidate: ResolvedTextCandidate | null): void => {
      if (candidate && !sameCandidate(candidate, primary) && !chain.some((entry) => sameCandidate(entry, candidate))) chain.push(candidate);
    };

    if (governance.agentSlug && governance.agentSlug !== agent.slug) {
      const fallbackAgent = await this.tryResolveAgent(tenantId, governance.agentSlug, 'fallback agent', agent.slug);
      const model = fallbackAgent ? primaryModelOf(fallbackAgent) : undefined;
      if (fallbackAgent && model) push(await this.candidate(fallbackAgent, model, 'fallback-agent', tenantId));
    } else {
      for (const model of fallbackModelsOf(agent)) push(await this.candidate(agent, model, 'fallback-model', tenantId));
    }

    // TASK-890 OD-M — the terminal SYSTEM-assigned candidate is GONE. The chain is the agent's
    // OWN governance: its `AgentModelFallback` rows, or the `parameters.fallback.agentSlug` it
    // names, both resolved in the CALLER's tenant. A platform agent still appears here — as the
    // tenant's own provisioned clone of it — but it is never appended by reading the SYSTEM
    // tenant's assignment behind the tenant's back. "Fallback" is the tenant's decision (§1.5),
    // and a tenant that wants the platform default in its chain says so on the agent.

    return {
      schemaVersion: RESOLVED_TEXT_SPEC_SCHEMA_VERSION,
      agent,
      primary,
      fallback: { autoSwitch: effectiveAutoSwitch(governance.autoSwitch, primary.fundingTier), chain },
    };
  }

  private async tryResolveAgent(tenantId: string, slug: string, role: string, primarySlug: string): Promise<ResolvedAgent | null> {
    try {
      return await this.agents.resolve({ tenantId, task: AgentTask.TEXT_GENERATION, agentSlug: slug, departmentId: null });
    } catch (error) {
      this.logger.warn({
        message: `Text ${role} did not resolve; continuing without it`,
        tenantId,
        agentSlug: primarySlug,
        fallbackAgentSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * One candidate with its funding DERIVED. `null` drops it from the chain: no provider-native
   * id, or a cloud FALLBACK whose credential is vetoed / un-entitled / absent (it could only
   * 503). The PRIMARY is never dropped for a credential reason — a veto propagates, and "no
   * credential anywhere" stays attributable at the text service rather than being hidden here.
   */
  private async candidate(
    agent: ResolvedAgent,
    model: ResolvedAgentModel,
    kind: TextCandidateKind,
    tenantId: string,
  ): Promise<ResolvedTextCandidate | null> {
    const funding = await this.fundingFor(agent, model, kind, tenantId);
    if (!funding) return null;
    return toTextCandidate(agent, model, kind, funding);
  }

  private async fundingFor(
    agent: ResolvedAgent,
    model: ResolvedAgentModel,
    kind: TextCandidateKind,
    tenantId: string,
  ): Promise<CandidateFunding | null> {
    const provider = model.provider;
    const rowFunding: CandidateFunding = { fundingTier: fundingOfAgentRow(agent) };
    if (!provider || !isCloudByoProvider('llm', provider)) return rowFunding;

    if (!this.credentials) {
      // TASK-862's resolver not wired: the agent resolver's own one-hop override serves the primary.
      if (agent.providerOverride?.provider === provider) {
        return { fundingTier: agent.fundingTier ?? rowFunding.fundingTier, providerOverride: agent.providerOverride };
      }
      return kind === 'primary' ? rowFunding : null;
    }

    try {
      const binding = await this.credentials.resolve('llm', provider, tenantId);
      if (binding) return { fundingTier: binding.fundingTier, providerOverride: { provider, ...binding.override } };
      return kind === 'primary' ? rowFunding : null;
    } catch (error) {
      if (kind === 'primary' || !(error instanceof ProviderVetoedException || error instanceof QuotaExceededException)) throw error;
      this.logger.warn({
        message: 'Text fallback provider credential refused; candidate left out of the chain',
        tenantId,
        agentSlug: agent.slug,
        provider,
        kind,
        reason: error instanceof ProviderVetoedException ? 'vetoed' : 'platform-default-not-entitled',
      });
      return null;
    }
  }
}
