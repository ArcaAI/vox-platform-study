import { AgentTask, AgentVersionResolverService, IActiveUserContext, IEntitlementsService, TextAgentResolverService } from '@arcaai/applications';
import type { ResolvedAgent, ResolvedTextGenerationAgent } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Controller, Get, Headers, Inject, Optional, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { InternalTenantLockGuard } from '../../guards/internal-tenant-lock.guard';

/**
 * AgentVersionInternalController — `GET /internal/agents/:slug/versions/:versionNumber/resolved`
 * (TASK-1038, D-A): the harness's way to run the agent version a published workflow PINNED.
 *
 * `GET /internal/agents/resolve` serves the ACTIVE published version, so a `core.agent` node
 * pinned to `agentRef.versionNumber` could only refuse on drift. This route answers the pinned
 * version itself — PUBLISHED, or DEPRECATED (owner decision OD-21: a pinned version keeps running
 * after it is deprecated) — and nothing else: a draft, an unknown version, or another tenant's
 * agent is one 404 (404-over-403).
 *
 * The response is IDENTICAL in shape to `resolve`'s, deliberately: the same `ResolvedAgent`
 * materialisation (`AgentVersionResolverService` runs `AgentResolverService` against the pinned
 * row), and for a TEXT_GENERATION agent the same `textPrimary` + `textFallback` block, built after
 * the same workflow-step LLM allowance check. The harness parses both with one model.
 *
 * Same posture as its sibling: `@Public()` exempts the user-JWT chain; the class-level
 * `InternalServiceTokenGuard` authenticates the caller by `?service=harness` + `X-Service-Token`;
 * the tenant is MANDATORY (`X-Tenant-Id` and/or `?tenantId=`, which must agree) and CLS is pinned
 * to it before anything is read. A separate controller file (not a method on
 * `AgentInternalController`) so this change stays out of that file; the two share the mount.
 */
@ApiExcludeController()
@ApiTags('internal-agents')
@Public()
@UseGuards(InternalServiceTokenGuard, InternalTenantLockGuard)
@Controller('internal/agents')
export class AgentVersionInternalController {
  constructor(
    private readonly versions: AgentVersionResolverService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly textAgents: TextAgentResolverService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {}

  @Get(':slug/versions/:versionNumber/resolved')
  async resolveVersion(
    @Param('slug') slug: string,
    @Param('versionNumber') versionNumberParam: string,
    @Query('tenantId') tenantIdQuery: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ResolvedAgent | ResolvedTextGenerationAgent> {
    const tenantId = requireTenant(tenantIdHeader, tenantIdQuery);
    const versionNumber = Number(versionNumberParam);
    if (!/^\d+$/.test(versionNumberParam ?? '') || !Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      throw new ArgumentInvalidException('`versionNumber` must be a positive integer — the version the workflow pinned.');
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      const resolved = await this.versions.resolveVersion({ tenantId, slug, versionNumber });
      if (resolved.task !== AgentTask.TEXT_GENERATION) return resolved;
      // The same workflow-step LLM allowance `resolve` checks (TASK-890 L11): a pinned version
      // spends exactly what an active one does.
      await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
      const spec = await this.textAgents.resolveFromAgent(resolved, tenantId);
      return { ...resolved, textPrimary: spec.primary, textFallback: spec.fallback };
    });
  }
}

function requireTenant(tenantIdHeader: string | undefined, tenantIdQuery: string | undefined): string {
  const tenantId = tenantIdHeader?.trim() || tenantIdQuery?.trim();
  if (!tenantId) {
    throw new ArgumentInvalidException('`X-Tenant-Id` (or `tenantId`) is required — internal agent resolution is always tenant-scoped.');
  }
  if (tenantIdHeader && tenantIdQuery && tenantIdHeader.trim() !== tenantIdQuery.trim()) {
    throw new ArgumentInvalidException('`X-Tenant-Id` and `tenantId` disagree.');
  }
  return tenantId;
}
