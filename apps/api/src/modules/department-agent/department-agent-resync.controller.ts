import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AgentTemplateResyncCronService,
  AgentTemplateResyncService,
  AgentTemplateResyncSummary,
  ResyncDepartmentAgentsRequest,
} from '@arcaai/applications';
import { CanManage } from '../../decorators';

/**
 * Admin-triggered SYSTEM agent-library resync. A SEPARATE thin
 * controller sharing the `admin/department-agents` prefix — the
 * `TenantPipelineResyncController` precedent — so the reconciler carries the
 * SUPER_ADMIN gate rather than the tenant-admin `manage:DepartmentAgent` of the
 * main controller.
 *
 * Gated `@CanManage('Tenant')` — SUPER_ADMIN only — because it writes into
 * ARBITRARY target tenants, the same privilege posture as tenant provisioning.
 * A tenant admin has no need for it: their catalog is reconciled for them.
 *
 * `POST admin/department-agents/resync` — with `{ tenantId }` reconciles that one
 * tenant; with no body it sweeps EVERY non-SYSTEM tenant (the same all-tenant
 * sweep the nightly cron runs). This is the PRIMARY resync path; the nightly
 * sweep is off by default so a human stays in the loop unless an operator opts
 * in.
 */
@ApiBearerAuth()
@ApiTags('admin-department-agents')
@Controller('admin/department-agents')
export class DepartmentAgentResyncController {
  constructor(
    private readonly resyncService: AgentTemplateResyncService,
    private readonly resyncCronService: AgentTemplateResyncCronService,
  ) {}

  @Post('resync')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({
    summary: 'Resync tenant DepartmentAgent catalogs against the SYSTEM golden library',
    description:
      'Reconciles tenants against the SYSTEM agent golden library: missing golden ' +
      'agents are cloned in as locked copies (with an APPROVED template snapshot), ' +
      "and pristine locked copies are fast-forwarded to the golden template's " +
      'current content. UNLOCKED agents — customized, and rows the lineage could ' +
      'not prove pristine — are NEVER touched. With `{ tenantId }` reconciles that ' +
      'one tenant; with no body sweeps every non-SYSTEM tenant. Idempotent: ' +
      're-running returns an all-zero summary.',
  })
  @ApiResponse({ status: 200, description: 'Reconciliation summary { added, fastForwarded, skipped }' })
  @ApiResponse({ status: 400, description: 'Bad request — the SYSTEM tenant cannot be resynced against itself' })
  async resync(@Body() body: ResyncDepartmentAgentsRequest): Promise<AgentTemplateResyncSummary> {
    if (body?.tenantId) {
      return this.resyncService.resyncTenant(body.tenantId);
    }
    return this.resyncCronService.resyncAllTenants();
  }
}
