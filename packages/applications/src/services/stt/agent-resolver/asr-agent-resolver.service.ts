import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import type { ResolvedAgent, ResolvedAsrSpec } from '@arcaai/types';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { ProviderCredentialResolver } from '../../ai-provider-connection/provider-credential-resolver';
import { isCloudByoProvider } from '../../ai-provider-connection/constants';
import type { ProviderFunding } from '../../ai-provider-connection/IProviderConnectionService';
import type { SttProviderOverrides } from '../../tenant-stt-config/platform-limits';
import { AsrSpecBuildError, buildResolvedAsrSpec } from './build-resolved-asr-spec';

export interface ResolveAsrSpecInput {
  tenantId: string;
  /** Explicit agent (lineage slug). Absent ⇒ the `AgentAssignment` cascade for `SPEECH_TO_TEXT`. */
  agentSlug?: string | null;
  departmentId?: string | null;
}

/** What one STT session / batch job needs from the gateway: the spec, plus the credentials that ride beside it. */
export interface ResolvedAsrSession {
  spec: ResolvedAsrSpec;
  /** Decrypted BYO/platform cloud credentials keyed by provider — in-memory only, never persisted with the job. */
  providerOverrides?: SttProviderOverrides;
  /** Which tier supplied the PRIMARY engine's credential — decides BYOK vs CLOUD metering. */
  fundingTier?: ProviderFunding;
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * TASK-861 §3.1 — the ONE resolution path from "start transcribing" to a
 * runnable `ResolvedAsrSpec`:
 *
 *  1. explicit `agentSlug` → a PUBLISHED, ACTIVE `SPEECH_TO_TEXT` agent visible to
 *     the tenant, else the `AgentAssignment` cascade `department → tenant → SYSTEM`
 *     — both through TASK-863's `AgentResolverService`, which also owns the
 *     404-over-403 posture (a foreign/unknown/unpublished slug is one 404);
 *  2. the agent's `parameters.fallback.agentSlug` is resolved the same way and
 *     embedded (kind `agent`); absent, the agent's own `AgentModelFallback` chain
 *     serves (kind `model`); a fallback that will not resolve DEGRADES to the next
 *     option — resilience configuration never blocks the primary session;
 *  3. `buildResolvedAsrSpec` folds it into the §3.2 blocks. An agent that cannot
 *     become a runnable spec (no primary model) FAILS CLOSED with a 409;
 *  4. every cloud engine in the chain gets its credential from TASK-862's
 *     `ProviderCredentialResolver` (`stt`, provider, tenant) as `provider_overrides`
 *     — the wire entry `apps/stt` already consumes — with the funding tier derived
 *     from the row that served. A veto / entitlement refusal propagates (fail
 *     closed); "no credential anywhere" simply yields no entry (the runtime then
 *     proceeds on platform env creds, exactly as the retired
 *     `TenantSttConfig.resolveProviderOverrides` path did).
 *
 * Replaces: `PipelineService.getById/getAll` + `TenantSttConfigService.getEffective`
 * + `resolveProviderOverrides` on the session/batch/compat entry points.
 */
@Injectable()
export class AsrAgentResolverService {
  private readonly logger = new Logger(AsrAgentResolverService.name);

  constructor(
    private readonly agents: AgentResolverService,
    // Optional so positional test construction and a stack without TASK-862's
    // resolver still work: the agent resolver's own `providerOverride` then serves.
    @Optional() private readonly credentials?: ProviderCredentialResolver,
  ) {}

  async resolve(input: ResolveAsrSpecInput): Promise<ResolvedAsrSession> {
    const { tenantId } = input;
    const agent = await this.agents.resolve({
      tenantId,
      task: AgentTask.SPEECH_TO_TEXT,
      agentSlug: input.agentSlug ?? null,
      departmentId: input.departmentId ?? null,
    });

    const fallbackAgent = await this.resolveFallbackAgent(agent, tenantId);

    let spec: ResolvedAsrSpec;
    try {
      spec = buildResolvedAsrSpec({ agent, fallbackAgent });
    } catch (error) {
      if (error instanceof AsrSpecBuildError) throw new ConflictException({ code: 'ASR_AGENT_UNRUNNABLE', message: error.message });
      throw error;
    }

    const { providerOverrides, fundingTier } = await this.resolveCredentials(spec, agent, fallbackAgent, tenantId);
    return { spec, ...(providerOverrides ? { providerOverrides } : {}), ...(fundingTier ? { fundingTier } : {}) };
  }

  private async resolveFallbackAgent(agent: ResolvedAgent, tenantId: string): Promise<ResolvedAgent | null> {
    const slug = rec(rec(agent.compiledConfig.parameters).fallback).agentSlug;
    if (typeof slug !== 'string' || slug.length === 0 || slug === agent.slug) return null;
    try {
      return await this.agents.resolve({ tenantId, task: AgentTask.SPEECH_TO_TEXT, agentSlug: slug, departmentId: null });
    } catch (error) {
      this.logger.warn({
        message: 'ASR fallback agent did not resolve; continuing without it',
        tenantId,
        agentSlug: agent.slug,
        fallbackAgentSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * One credential per distinct cloud provider in the chain (primary first, so
   * the funding tier reported is the PRIMARY engine's).
   */
  private async resolveCredentials(
    spec: ResolvedAsrSpec,
    agent: ResolvedAgent,
    fallbackAgent: ResolvedAgent | null,
    tenantId: string,
  ): Promise<{ providerOverrides?: SttProviderOverrides; fundingTier?: ProviderFunding }> {
    const providers: string[] = [];
    for (const provider of [spec.models.asr.provider, spec.fallback.spec?.models.asr.provider ?? null]) {
      if (provider && isCloudByoProvider('stt', provider) && !providers.includes(provider)) providers.push(provider);
    }
    if (providers.length === 0) return {};

    const overrides: SttProviderOverrides = {};
    let fundingTier: ProviderFunding | undefined;
    for (const provider of providers) {
      const entry = this.credentials
        ? await this.credentials.resolve('stt', provider, tenantId).then((binding) => binding?.override ?? null)
        : (this.overrideFromAgents(provider, agent, fallbackAgent) ?? null);
      if (!entry) continue;
      overrides[provider] = entry;
      fundingTier ??= entry.funding;
    }
    return Object.keys(overrides).length > 0 ? { providerOverrides: overrides, fundingTier } : {};
  }

  /** Fallback when TASK-862's resolver is not wired: the override the agent resolver already derived. */
  private overrideFromAgents(provider: string, agent: ResolvedAgent, fallbackAgent: ResolvedAgent | null): SttProviderOverrides[string] | undefined {
    for (const candidate of [agent, fallbackAgent]) {
      const override = candidate?.providerOverride;
      if (override && override.provider === provider) {
        const { provider: _provider, ...entry } = override;
        return entry as SttProviderOverrides[string];
      }
    }
    return undefined;
  }
}
