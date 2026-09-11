import { ConflictException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import type { ResolvedAgent, ResolvedAsrSpec } from '@arcaai/types';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { ProviderCredentialResolver } from '../../ai-provider-connection/provider-credential-resolver';
import { CLOUD_BYO_PROVIDERS, isCloudByoProvider } from '../../ai-provider-connection/constants';
import { ProviderVetoedException } from '../../ai-provider-connection/provider-vetoed.exception';
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
  /**
   * Which tier supplied the PRIMARY engine's credential (`undefined` when the
   * primary is self-hosted or has no credential at either tier).
   *
   * TASK-874 — this is the PRIMARY's alone and must never be stamped on a ledger
   * row for the whole session: a session can fail over to the platform fallback
   * mid-flight, and the engine that SERVED each span decides its funding. The
   * per-engine truth is `providerOverrides[provider].funding`, which `apps/stt`
   * reads under the key the loader actually used to bill engine-time.
   */
  fundingTier?: ProviderFunding;
  /**
   * TASK-951 R2 (D-8) — the context schema the resolved agent BINDS, exactly as frozen into
   * `compiledConfig.contextSchema` at publish time, or `undefined` when it binds none.
   *
   * Surfaced here because the agent row is resolved inside this service and nowhere else on the
   * STT entry path: without it the gateway would have to resolve the same agent a SECOND time
   * just to learn what `context` it may accept. Frozen, never re-read — a tenant that edits its
   * schema after publishing does not silently change what a live agent accepts (the same
   * invariant `AgentInvocationService.contextProblems` relies on).
   *
   * It is deliberately NOT part of `ResolvedAsrSpec`: the spec is the cross-language contract
   * `apps/stt` consumes (pydantic mirror + parity fixture), and the echo never reaches `apps/stt`.
   */
  contextSchema?: NonNullable<ResolvedAgent['compiledConfig']['contextSchema']>;
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
 *     — the wire entry `apps/stt` already consumes — with each engine's funding
 *     tier derived from the row that served IT (TASK-874: the fallback's funding
 *     is its own, and is what bills the fallback's engine-time). A veto / entitlement refusal propagates (fail
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
      spec = buildResolvedAsrSpec({
        agent,
        fallbackAgent,
        // TASK-934 — a decode profile the row declared but this gateway cannot act on
        // (unknown key, wrong type, out of range) is DROPPED, because tuning is
        // `open-to-default` and a session must not fail on it. This is what stops it
        // being silent: §2.2 spent a day on a profile value that never took effect.
        onProfileRejection: ({ modelSlug, rejected }) =>
          this.logger.warn(
            `ASR model '${modelSlug}' declares _metadata.asr members this runtime ignored: ${rejected.join(', ')}. ` +
              `Fix them on the model row — the engine default applies until then.`,
          ),
      });
    } catch (error) {
      // TASK-880 — `code` is the error's own now, so an embedding-space mismatch is
      // distinguishable from "this agent resolved no primary model" by a caller that
      // only sees the 409 body.
      if (error instanceof AsrSpecBuildError) throw new ConflictException({ code: error.code, message: error.message });
      throw error;
    }

    const { providerOverrides, fundingTier } = await this.resolveCredentials(spec, agent, fallbackAgent, tenantId);
    // TASK-951 — the PRIMARY agent's bound schema. The fallback agent's is deliberately ignored:
    // a session's accepted `context` is decided once, at create, and must not change under the
    // caller when the engine fails over mid-session.
    const contextSchema = agent.compiledConfig.contextSchema ?? undefined;
    return {
      spec,
      ...(providerOverrides ? { providerOverrides } : {}),
      ...(fundingTier ? { fundingTier } : {}),
      ...(contextSchema ? { contextSchema } : {}),
    };
  }

  /**
   * TASK-861 follow-up — the batch worker's whole-service credential pull
   * (`GET internal/stt/provider-overrides?tenantId=`), successor of the
   * deprecated `TenantSttConfigService.resolveProviderOverrides`.
   *
   * The Dramatiq message carries `resolved_spec` and never a key, and the
   * worker names no provider when it pulls, so every cloud STT provider the
   * platform knows is resolved through the ONE resolver exactly as
   * `resolveCredentials` does for a session's chain — tenant row → SYSTEM
   * fallback, `funding` derived from the row that served — keyed as the
   * `apps/stt` loaders read it.
   *
   * Fail-closed PER PROVIDER, not per pull: a veto (`ProviderVetoedException`,
   * a DISABLED tenant row) or an entitlement refusal of the platform default
   * (`QuotaExceededException`) leaves that provider OUT of the map. No tier
   * serves it, and every STT cloud loader is BYOK-only with no env key, so a
   * job on that engine fails at load rather than on another tier's credential
   * — while a tenant that vetoed one provider still transcribes on another.
   * (A session names its chain, so `resolve` lets the veto propagate as a 409;
   * a whole-service map cannot tell which provider the job runs on.) A
   * backend fault propagates — it is never disguised as "no credential".
   */
  async resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides> {
    if (!this.credentials) {
      throw new ServiceUnavailableException('Provider credential resolution is not configured on this gateway');
    }
    const overrides: SttProviderOverrides = {};
    for (const provider of CLOUD_BYO_PROVIDERS.stt) {
      try {
        const binding = await this.credentials.resolve('stt', provider, tenantId);
        if (binding) overrides[provider] = binding.override;
      } catch (error) {
        if (!(error instanceof ProviderVetoedException) && !(error instanceof QuotaExceededException)) throw error;
        this.logger.warn({
          message: 'STT provider credential refused; provider left out of the batch pull',
          tenantId,
          provider,
          reason: error instanceof ProviderVetoedException ? 'vetoed' : 'platform-default-not-entitled',
        });
      }
    }
    return overrides;
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
   * One credential per distinct cloud provider in the chain — the primary's AND
   * the fallback's, each with the funding DERIVED from the row that served it.
   *
   * TASK-874 — both entries matter, because fallback to the platform default is
   * a metered HA capability: `apps/stt` bills engine-time by looking each served
   * engine's own entry up. `fundingTier` is therefore resolved from the PRIMARY
   * engine's provider SPECIFICALLY, not first-resolved-wins over the chain. The
   * old `??=` reported the FALLBACK's tier under the primary's name for the
   * commonest HA shape — a self-hosted primary with a cloud fallback contributes
   * no provider of its own, so the fallback was simply first in the list.
   */
  private async resolveCredentials(
    spec: ResolvedAsrSpec,
    agent: ResolvedAgent,
    fallbackAgent: ResolvedAgent | null,
    tenantId: string,
  ): Promise<{ providerOverrides?: SttProviderOverrides; fundingTier?: ProviderFunding }> {
    const primaryProvider = spec.models.asr.provider;
    const providers: string[] = [];
    for (const provider of [primaryProvider, spec.fallback.spec?.models.asr.provider ?? null]) {
      if (provider && isCloudByoProvider('stt', provider) && !providers.includes(provider)) providers.push(provider);
    }
    if (providers.length === 0) return {};

    const overrides: SttProviderOverrides = {};
    for (const provider of providers) {
      const entry = this.credentials
        ? await this.credentials.resolve('stt', provider, tenantId).then((binding) => binding?.override ?? null)
        : (this.overrideFromAgents(provider, agent, fallbackAgent) ?? null);
      if (!entry) continue;
      overrides[provider] = entry;
    }
    if (Object.keys(overrides).length === 0) return {};
    const fundingTier = primaryProvider ? overrides[primaryProvider]?.funding : undefined;
    return { providerOverrides: overrides, ...(fundingTier ? { fundingTier } : {}) };
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
