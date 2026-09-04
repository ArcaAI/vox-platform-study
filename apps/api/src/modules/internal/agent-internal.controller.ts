import { AgentResolverService, AgentTask, IActiveUserContext } from '@arcaai/applications';
import type { ResolvedAgent } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
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
  ) {}

  @Get('resolve')
  async resolve(
    @Query('tenantId') tenantIdQuery: string | undefined,
    @Query('task') task: string | undefined,
    @Query('agentSlug') agentSlug: string | undefined,
    @Query('departmentId') departmentId: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ResolvedAgent> {
    const tenantId = tenantIdHeader?.trim() || tenantIdQuery?.trim();
    if (!tenantId) {
      throw new ArgumentInvalidException('`X-Tenant-Id` (or `tenantId`) is required — internal agent resolution is always tenant-scoped.');
    }
    if (tenantIdHeader && tenantIdQuery && tenantIdHeader.trim() !== tenantIdQuery.trim()) {
      throw new ArgumentInvalidException('`X-Tenant-Id` and `tenantId` disagree.');
    }
    if (!task && !agentSlug) {
      throw new ArgumentInvalidException('Either `task` or `agentSlug` is required.');
    }
    if (task && !Object.values(AgentTask).includes(task as AgentTask)) {
      throw new ArgumentInvalidException(`Unknown task '${task}'; expected one of ${Object.values(AgentTask).join(', ')}.`);
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.resolver.resolve({
        tenantId,
        task: task as AgentTask | undefined,
        agentSlug: agentSlug || null,
        departmentId: departmentId || null,
      });
    });
  }
}
