import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ITenantReferenceSetService, ReferenceSetSummaryResponse, SyncReferenceSetRequest } from '@arcaai/applications';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * TASK-890 §3.4 — re-provision one tenant from the SYSTEM REFERENCE SET.
 *
 * A SEPARATE thin controller sharing the `admin/tenants` prefix, following the
 * `TenantPipelineResyncController` / `TenantProvisionController` precedent: it keeps a
 * cross-tenant reconciler off `TenantController` (whose routes are tenant CRUD) while still
 * living at the tenant-shaped URL the console calls.
 *
 * Gated `@CanManage('Tenant')` — SUPER_ADMIN only — because it WRITES into an arbitrary target
 * tenant, the same privilege posture as tenant provisioning. A tenant admin has no need for it:
 * their content is provisioned for them at creation, and what they do with it afterwards is
 * theirs. `@ForbidApiKey()` for the same reason every admin route carries it.
 *
 * This is the repair path for the two states §3.4 can leave: a tenant created before the
 * reference set existed (the one-shot backfill runs this same call in a loop), and a tenant
 * whose copy of one kind failed at creation — which is a logged WARNING there, and a listed
 * `warnings` entry here, never a silence.
 */
@ApiBearerAuth()
@ApiTags('admin-tenants')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:tenant:write')
@Controller('admin/tenants')
export class TenantReferenceSetController {
  constructor(@Inject(ITenantReferenceSetService) private readonly referenceSet: ITenantReferenceSetService) {}

  @Post(':id/reference-set/sync')
  @HttpCode(200)
  @CanManage('Tenant')
  @ApiOperation({
    summary: "Re-provision a tenant from the platform's SYSTEM reference set",
    description:
      'Copies the platform reference set — context schemas, prompt templates, agents (with ' +
      'their TENANT assignments) and workflow definitions — into one tenant. `missing-only` ' +
      '(the default) adds what the tenant lacks and touches nothing it already has; ' +
      '`refresh-locked` additionally fast-forwards rows still marked `templateLocked` and ' +
      'NEVER touches a row the tenant has edited. Idempotent: a second run reports zero added. ' +
      'Per-row failures are reported in `warnings` rather than aborting the run.',
  })
  @ApiParam({ name: 'id', description: 'Target tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Per-kind reconciliation summary', type: ReferenceSetSummaryResponse })
  @ApiResponse({ status: 400, description: 'Bad request — the SYSTEM tenant is the reference set and cannot be synced from itself' })
  @ApiResponse({ status: 403, description: 'Forbidden — writing another tenant is a platform-administrator action' })
  async sync(@Param('id') id: string, @Body() request: SyncReferenceSetRequest): Promise<ReferenceSetSummaryResponse> {
    return (await this.referenceSet.resync(id, { mode: request.mode, kinds: request.kinds })) as ReferenceSetSummaryResponse;
  }
}
