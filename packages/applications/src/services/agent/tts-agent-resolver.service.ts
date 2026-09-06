import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AgentTask, AiModelRepository, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import type { AgentFundingTier, ResolvedAgent, ResolvedAgentModel, ResolvedTtsSpec } from '@arcaai/types';
import { readAgentFallbackGovernance } from '@arcaai/workflow-contract';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type {
  IProviderConnectionService as IProviderConnectionServicePort,
  ProviderOverrides,
} from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { ProviderCredentialResolver } from '../ai-provider-connection/provider-credential-resolver';
import { ProviderVetoedException } from '../ai-provider-connection/provider-vetoed.exception';
import { AgentResolverService } from './agent-resolver.service';
import { fundingOfAgentRow } from './text-generation-spec';
import {
  TtsSpecBuildError,
  buildResolvedTtsSpec,
  fallbackTtsModelsOf,
  primaryTtsModelOf,
  ttsEngineProvider,
  type TtsCandidateSource,
} from './tts-spec';
import type { TtsCandidateKind, TtsSpecConnection } from '@arcaai/types';

export interface ResolveTtsSpecInput {
  tenantId: string;
  /** Explicit agent (lineage slug). Absent ⇒ the `AgentAssignment` cascade for `TEXT_TO_SPEECH`. */
  agentSlug?: string | null;
  departmentId?: string | null;
}

/** What ONE synthesis request needs from the gateway: the spec, plus the credentials that ride beside it. */
export interface ResolvedTtsSession {
  spec: ResolvedTtsSpec;
  /** Decrypted BYO/platform cloud credentials keyed by engine — in-memory only, never persisted. */
  providerOverrides?: ProviderOverrides;
}

/**
 * TASK-879 — the ONE resolution from "speak this for tenant T" to a runnable `ResolvedTtsSpec`,
 * the TEXT_TO_SPEECH sibling of `AsrAgentResolverService` and `TextAgentResolverService`:
 *
 *  1. explicit `agentSlug` → a PUBLISHED, ACTIVE `TEXT_TO_SPEECH` agent visible to the tenant,
 *     else the `AgentAssignment` cascade `department → tenant → SYSTEM` — both through TASK-863's
 *     `AgentResolverService`, which owns the 404-over-403 posture (a foreign / unknown /
 *     unpublished slug is one 404);
 *  2. the ORDERED fallback chain (owner decision TASK-870 #4 — fallback is a platform HA
 *     capability, ON by default): the agent's `parameters.fallback.agentSlug` when it names one
 *     (kind `fallback-agent`), else the agent's own `AgentModelFallback` chain (kind
 *     `fallback-model`); and ALWAYS the SYSTEM-assigned agent as the terminal `platform-default`
 *     unless the primary already is it. A fallback that will not resolve DEGRADES to the next
 *     option — resilience configuration never blocks the primary synthesis;
 *  3. every candidate carries the NON-SECRET facts of the `AiProviderConnection` row that serves
 *     its engine — endpoint, region, timeout — with funding DERIVED from the tier that supplied
 *     the row. A self-hosted engine with NO enabled row carries `connection: null`, which is what
 *     `tts.<engine>.enabled` used to say: this deployment does not run that engine, so the
 *     runtime walks past it rather than routing into an engine the platform did not enable;
 *  4. every CLOUD engine in the chain gets its credential from TASK-862's
 *     `ProviderCredentialResolver` (`tts`, engine, tenant) as `provider_overrides` — the wire
 *     entry `apps/tts` already consumes. A veto / entitlement refusal on the PRIMARY propagates
 *     (fail closed); on a FALLBACK it leaves that candidate out of the chain, so a tenant that
 *     vetoed one vendor still synthesises on another.
 *
 * Replaces, on all three speech entry points: `TenantTtsConfigService.getEffective` (routing
 * chains, allowed providers, voice bindings, format/speed/sample-rate defaults) and the
 * whole-service `resolveTenantCloudOverrides` fold.
 */
@Injectable()
export class TtsAgentResolverService {
  private readonly logger = new Logger(TtsAgentResolverService.name);

  constructor(
    private readonly agents: AgentResolverService,
    @Inject(IAgentAssignmentService) private readonly assignments: IAgentAssignmentServicePort,
    private readonly aiModelRepository: AiModelRepository,
    // Both optional so positional test construction and a stack without TASK-862's plane still
    // work: the spec then carries no connection block and no credential, and `apps/tts` fails
    // closed on the candidate rather than inventing an endpoint.
    @Optional() @Inject(IProviderConnectionService) private readonly connections?: IProviderConnectionServicePort,
    @Optional() private readonly credentials?: ProviderCredentialResolver,
  ) {}

  async resolve(input: ResolveTtsSpecInput): Promise<ResolvedTtsSession> {
    const agent = await this.agents.resolve({
      tenantId: input.tenantId,
      task: AgentTask.TEXT_TO_SPEECH,
      agentSlug: input.agentSlug ?? null,
      departmentId: input.departmentId ?? null,
    });
    return this.resolveFromAgent(agent, input.tenantId);
  }

  /** The chain for an agent the caller already resolved. */
  async resolveFromAgent(agent: ResolvedAgent, tenantId: string): Promise<ResolvedTtsSession> {
    if (agent.task !== AgentTask.TEXT_TO_SPEECH) {
      throw new BadRequestException(`Agent '${agent.slug}' is a ${agent.task} agent; a speech spec needs TEXT_TO_SPEECH.`);
    }
    const primaryModel = primaryTtsModelOf(agent);
    if (!primaryModel) {
      throw new ConflictException({
        code: 'TTS_AGENT_UNRUNNABLE',
        message: `Agent '${agent.slug}' v${agent.versionNumber} resolved no primary text-to-speech model; republish it on a registered model.`,
      });
    }

    const overrides: ProviderOverrides = {};
    const primary = await this.source(agent, primaryModel, 'primary', tenantId, overrides);
    if (!primary) {
      // Unreachable for `kind: 'primary'` — `source` never returns null there — but stated so a
      // future edit cannot silently turn a primary failure into an empty spec.
      throw new ConflictException({
        code: 'TTS_AGENT_UNRUNNABLE',
        message: `Agent '${agent.slug}' v${agent.versionNumber} could not be resolved to a runnable engine.`,
      });
    }

    const governance = readAgentFallbackGovernance(agent.compiledConfig.parameters);
    const chain: TtsCandidateSource[] = [];
    const push = (source: TtsCandidateSource | null): void => {
      if (source) chain.push(source);
    };

    if (governance.agentSlug && governance.agentSlug !== agent.slug) {
      const fallbackAgent = await this.tryResolveAgent(tenantId, governance.agentSlug, 'fallback agent', agent.slug);
      const model = fallbackAgent ? primaryTtsModelOf(fallbackAgent) : undefined;
      if (fallbackAgent && model) push(await this.source(fallbackAgent, model, 'fallback-agent', tenantId, overrides));
    } else {
      for (const model of fallbackTtsModelsOf(agent)) push(await this.source(agent, model, 'fallback-model', tenantId, overrides));
    }

    // TASK-890 OD-M — the terminal SYSTEM-assigned candidate is GONE, for the reason spelled
    // out on the TEXT resolver: the chain is the agent's own governance, resolved in the
    // caller's tenant, and the platform default reaches a tenant as its OWN clone rather than as
    // a read of the SYSTEM tenant's assignment.

    let spec: ResolvedTtsSpec;
    try {
      spec = buildResolvedTtsSpec({ primary, chain, autoSwitch: governance.autoSwitch });
    } catch (error) {
      if (error instanceof TtsSpecBuildError) throw new ConflictException({ code: 'TTS_AGENT_UNRUNNABLE', message: error.message });
      throw error;
    }

    // Only the engines the spec actually kept may carry a credential: the chain de-dupes by
    // dispatch endpoint, so a dropped duplicate must not leave a key on the wire for an engine
    // nothing will route to.
    const kept = new Set([spec.primary, ...spec.fallback.chain].map((candidate) => candidate.model.provider).filter((p): p is string => !!p));
    for (const provider of Object.keys(overrides)) {
      if (!kept.has(provider)) delete overrides[provider];
    }
    return { spec, ...(Object.keys(overrides).length > 0 ? { providerOverrides: overrides } : {}) };
  }

  private async tryResolveAgent(tenantId: string, slug: string, role: string, primarySlug: string): Promise<ResolvedAgent | null> {
    try {
      return await this.agents.resolve({ tenantId, task: AgentTask.TEXT_TO_SPEECH, agentSlug: slug, departmentId: null });
    } catch (error) {
      this.logger.warn({
        message: `Speech ${role} did not resolve; continuing without it`,
        tenantId,
        agentSlug: primarySlug,
        fallbackAgentSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * One candidate source: the model's `_metadata`, the connection that serves its engine, and the
   * funding tier DERIVED from the row that supplied it. `null` drops the candidate — reserved for
   * a cloud FALLBACK whose credential is vetoed, un-entitled or absent (it could only 401).
   */
  private async source(
    agent: ResolvedAgent,
    model: ResolvedAgentModel,
    kind: TtsCandidateKind,
    tenantId: string,
    overrides: ProviderOverrides,
  ): Promise<TtsCandidateSource | null> {
    const metaData = await this.metaDataFor(model, tenantId);
    const engine = ttsEngineProvider(model, metaData);

    if (engine && isCloudByoProvider('tts', engine)) {
      const credentialled = await this.applyCloudCredential(agent, engine, kind, tenantId, overrides);
      if (!credentialled) return null;
    }

    const connection = engine ? await this.connectionFor(engine, tenantId) : null;
    const fundingTier: AgentFundingTier = overrides[engine ?? '']?.funding ?? (connection ? connection.funding : fundingOfAgentRow(agent));

    return { agent, model, kind, metaData, connection, fundingTier };
  }

  /**
   * Resolve the cloud credential for `engine` into `overrides`. Returns whether the candidate may
   * stay in the chain.
   *
   * The PRIMARY is never dropped for a credential reason — a veto propagates as a 409, and "no
   * credential anywhere" stays attributable at `apps/tts` (which refuses the engine) rather than
   * being hidden here as a silently shorter chain.
   */
  private async applyCloudCredential(
    agent: ResolvedAgent,
    engine: string,
    kind: TtsCandidateKind,
    tenantId: string,
    overrides: ProviderOverrides,
  ): Promise<boolean> {
    if (overrides[engine]) return true;
    if (!this.credentials) {
      // TASK-862's resolver is not wired: the agent resolver's own one-hop override serves.
      const own = agent.providerOverride;
      if (own && own.provider === engine) {
        const { provider: _provider, ...entry } = own;
        overrides[engine] = entry as ProviderOverrides[string];
        return true;
      }
      return kind === 'primary';
    }
    try {
      const binding = await this.credentials.resolve('tts', engine, tenantId);
      if (binding) {
        overrides[engine] = binding.override;
        return true;
      }
      return kind === 'primary';
    } catch (error) {
      if (kind === 'primary' || !(error instanceof ProviderVetoedException || error instanceof QuotaExceededException)) throw error;
      this.logger.warn({
        message: 'Speech fallback provider credential refused; candidate left out of the chain',
        tenantId,
        agentSlug: agent.slug,
        provider: engine,
        kind,
        reason: error instanceof ProviderVetoedException ? 'vetoed' : 'platform-default-not-entitled',
      });
      return false;
    }
  }

  /** The connection row that serves `engine`, projected onto the wire block. `null` = no enabled row. */
  private async connectionFor(engine: string, tenantId: string): Promise<TtsSpecConnection | null> {
    if (!this.connections) return null;
    const resolved = await this.connections.resolveConnection('tts', engine, tenantId);
    if (!resolved) return null;
    return {
      provider: engine,
      baseUrl: resolved.baseUrl ?? null,
      region: resolved.region ?? null,
      timeoutS: resolved.timeoutS ?? null,
      funding: resolved.source === 'tenant' ? 'tenant' : 'platform',
    };
  }

  /** `AiModel._metadata` for a materialised model — voices and artifact paths the loader needs. */
  private async metaDataFor(model: ResolvedAgentModel, tenantId: string): Promise<unknown> {
    const own = tenantId === SYSTEM_TENANT_ID ? null : await this.aiModelRepository.findBySlug(tenantId, model.slug).catch(() => null);
    const row = own ?? (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, model.slug).catch(() => null));
    return row?.metaData ?? null;
  }
}
