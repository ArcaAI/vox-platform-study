import { BadRequestException, Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { EntitlementCapabilitiesResponse, IActiveUserContext, IEntitlementsService } from '@arcaai/applications';
import { Authorize } from '../../decorators';

/**
 * TASK-392 (Phase 4) — tenant self-service entitlements snapshot.
 *
 * Reachable at `/api/v1/entitlements/me`. Gated with `read Tenant` (the
 * tenant-scoped policy grants it for `id = context.tenantId`), so a tenant
 * admin sees ONLY their own tenant's capabilities/usage — mirroring the
 * `/tenant/me` self-view. Global-admins manage other tenants via the
 * `/admin/entitlements/*` surface, not here (no silent global fallback).
 */
@ApiTags('entitlements')
@ApiBearerAuth()
@Controller('entitlements')
export class MyEntitlementsController {
  constructor(
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get('me')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: "Capability/usage snapshot for the caller's own tenant (limits, usage, meters, features, trial clock)." })
  @ApiResponse({ status: 200, type: EntitlementCapabilitiesResponse })
  @ApiResponse({ status: 400, description: 'No tenant context present.' })
  me(): Promise<EntitlementCapabilitiesResponse> {
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required. Global-admins must use /admin/entitlements endpoints.');
    }
    return this.entitlements.getCapabilities(tenantId);
  }
}
