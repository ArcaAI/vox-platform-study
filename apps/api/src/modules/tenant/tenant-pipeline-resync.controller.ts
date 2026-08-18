import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PipelineTemplateResyncService, PipelineTemplateResyncSummary } from '@arcaai/applications';
import { CanManage, ForbidApiKey } from '../../decorators';

/**
 * Admin-triggered SYSTEM-template resync for one tenant.
 *
 * A SEPARATE thin controller sharing the `admin/tenants` prefix, following the
 * `TenantProvisionController` precedent: it keeps the pipeline
 * reconciler off `TenantController` (whose routes are tenant CRUD) while still
 * living at the tenant-shaped URL the console calls.
 *
 * Gated `@CanManage('Tenant')` — SUPER_ADMIN only — because it writes into an
 * arbitrary target tenant, the same privilege posture as tenant provisioning.
 * A tenant admin has no need for it: their catalog is reconciled for them.
 *
 * This is the PRIMARY resync path. The nightly sweep
 * (`PipelineTemplateResyncCronService`) is off by default precisely so that a
 * human stays in the loop unless an operator opts in.
 */
@ApiBearerAuth()
@ApiTags('admin-tenants')
@ForbidApiKey()
@Controller('admin/tenants')
export class TenantPipelineResyncController {
  constructor(private readonly resyncService: PipelineTemplateResyncService) {}

  @Post(':id/pipelines/resync')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({
    summary: "Resync a tenant's ASR pipeline catalog against the SYSTEM templates",
    description:
      'Reconciles one tenant against the SYSTEM template catalog: missing ' +
      'templates are cloned in as locked copies, and pristine locked copies are ' +
      "fast-forwarded to the template's current config (each fast-forward writes " +
      'a new version snapshot). UNLOCKED rows — customized pipelines, and rows ' +
      'the lineage backfill could not prove pristine — are NEVER touched. ' +
      'Idempotent: re-running returns an all-zero summary.',
  })
  @ApiParam({ name: 'id', description: 'Target tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Reconciliation summary { added, fastForwarded, skipped }' })
  @ApiResponse({ status: 400, description: 'Bad request — the SYSTEM tenant cannot be resynced against itself' })
  async resync(@Param('id') id: string): Promise<PipelineTemplateResyncSummary> {
    return this.resyncService.resyncTenant(id);
  }
}
