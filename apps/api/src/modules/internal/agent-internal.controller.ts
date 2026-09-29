import {
  AgentResolverService,
  AgentTask,
  AsrAgentResolverService,
  IActiveUserContext,
  IEntitlementsService,
  TextAgentResolverService,
} from '@arcaai/applications';
import type { ResolvedAgent, ResolvedAsrSpec, ResolvedTextGenerationAgent } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Controller, Get, Headers, Inject, Optional, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';

/**
 * AgentInternalController — `GET /internal/agents/resolve` (TASK-863 §3.4), the harness's
 * `core.agent` activity's (TASK-864) entry into the ONE agent resolution.
 *
 * Contract: `?service=harness` (the guard's secret selector) + `X-Service-Token`, and the
 * tenant is MANDATORY — as `X-Tenant-Id` (owner directive 2026-08-16: every internal call
 * carrying tenant-scoped work names its tenant) and/or `?tenantId=`; when both are present
 * they must agree. `?task=` selects through the assignment cascade; `?agentSlug=` pins a
 * lineage; `?departmentId=` adds the department tier.
 *
 * `@Public()` exempts the route from the user-JWT chain (it is authenticated
 * service-to-service by the class-level guard); CLS is re-established pinned to the CALLER'S
 * tenant so the tenant-scope extension widens reads to [tenant, SYSTEM] exactly as it would
 * for a user request — never to SYSTEM alone, never to every tenant.
 *
 * TASK-876: a TEXT_GENERATION answer additionally carries `textPrimary` + `textFallback` — the
 * resolved PRIMARY candidate, and the agent's fallback governance and ORDERED chain (explicit
 * fallback agent | its own model chain, then the SYSTEM platform default), funding DERIVED per
 * candidate — built from the SAME resolved agent (`TextAgentResolverService.resolveFromAgent`, no
 * second resolution), so the harness `core.agent` activity can switch on primary failure without
 * another round trip. `textPrimary` is what makes the PRIMARY attempt attributable: bare
 * `ResolvedAgent.fundingTier` is populated only for a cloud BYO override, so a self-hosted
 * platform primary would otherwise meter as `null` while its own fallback metered `platform`.
 *
 * TASK-1010 OD-12: `GET /internal/agents/asr-spec` answers the `ResolvedAsrSpec` a live
 * streaming session would get for the same agent (the SAME `AsrAgentResolverService`), so the
 * asr-vllm bench exercises agent → registered model exactly as production does. Only `.spec`
 * crosses the wire; the session's decrypted `providerOverrides` never leave the gateway here.
 */
@ApiExcludeController()
@ApiTags('internal-agents')
@Public()
@UseGuards(InternalServiceTokenGuard)
@Controller('internal/agents')
export class AgentInternalController {
  constructor(
    private readonly resolver: AgentResolverService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly textAgents: TextAgentResolverService,
    // Optional + trailing so existing positional constructions keep their arity;
    // absent ⇒ no gate (metering is additive and must never break resolution).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // TASK-1010 — optional + trailing for the same arity reason as `entitlements`.
    @Optional() private readonly asrResolver?: AsrAgentResolverService,
  ) {}

  @Get('resolve')
  async resolve(
    @Query('tenantId') tenantIdQuery: string | undefined,
    @Query('task') task: string | undefined,
    @Query('agentSlug') agentSlug: string | undefined,
    @Query('departmentId') departmentId: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ResolvedAgent | ResolvedTextGenerationAgent> {
    const tenantId = this.requireTenant(tenantIdHeader, tenantIdQuery);
    if (!task && !agentSlug) {
      throw new ArgumentInvalidException('Either `task` or `agentSlug` is required.');
    }
    if (task && !Object.values(AgentTask).includes(task as AgentTask)) {
      throw new ArgumentInvalidException(`Unknown task '${task}'; expected one of ${Object.values(AgentTask).join(', ')}.`);
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      // TASK-890 §3.4 (OD-M) — `AGENT_NOT_ASSIGNED` needs NO mapping here, deliberately.
      // `AgentResolverService` raises it as a `ServiceUnavailableException` whose body already
      // carries `{ code, task, tenantId, departmentId }`, so Nest answers 503 with the named
      // payload and the harness step degrades on a reason it can print. Catching it here to
      // re-wrap it would only give the same fact two shapes — and the interceptor passes an
      // `HttpException` through untouched.
      const resolved = await this.resolver.resolve({
        tenantId,
        task: task as AgentTask | undefined,
        agentSlug: agentSlug || null,
        departmentId: departmentId || null,
      });
      if (resolved.task !== AgentTask.TEXT_GENERATION) return resolved;
      // TASK-890 — the workflow-step LLM allowance, checked BEFORE the answer is
      // handed over. Post-hoc debit (D6): the step's token count is unknowable
      // here, so this compares month-to-date rollups against the allowance, the
      // same call shape `summary.service.ts` uses. Only TEXT_GENERATION pays it:
      // an ASR or TTS resolution spends no LLM tokens.
      await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
      const spec = await this.textAgents.resolveFromAgent(resolved, tenantId);
      return { ...resolved, textPrimary: spec.primary, textFallback: spec.fallback };
    });
  }

  @Get('asr-spec')
  async asrSpec(
    @Query('tenantId') tenantIdQuery: string | undefined,
    @Query('agentSlug') agentSlug: string | undefined,
    @Query('departmentId') departmentId: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ResolvedAsrSpec> {
    const tenantId = this.requireTenant(tenantIdHeader, tenantIdQuery);
    const asrResolver = this.asrResolver;
    if (!asrResolver) {
      throw new ServiceUnavailableException('ASR agent resolution is not available on this gateway.');
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      const session = await asrResolver.resolve({ tenantId, agentSlug: agentSlug || null, departmentId: departmentId || null });
      return session.spec;
    });
  }

  private requireTenant(tenantIdHeader: string | undefined, tenantIdQuery: string | undefined): string {
    const tenantId = tenantIdHeader?.trim() || tenantIdQuery?.trim();
    if (!tenantId) {
      throw new ArgumentInvalidException('`X-Tenant-Id` (or `tenantId`) is required — internal agent resolution is always tenant-scoped.');
    }
    if (tenantIdHeader && tenantIdQuery && tenantIdHeader.trim() !== tenantIdQuery.trim()) {
      throw new ArgumentInvalidException('`X-Tenant-Id` and `tenantId` disagree.');
    }
    return tenantId;
  }
}
