import { BadRequestException, Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { EntitlementCapabilitiesResponse, IActiveUserContext, IEntitlementsService } from '@arcaai/applications';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * Tenant self-service entitlements snapshot.
 *
 * Reachable at `/api/v1/entitlements/me`. Gated with `read Tenant` (the
 * tenant-scoped policy grants it for `id = context.tenantId`), so a tenant
 * admin sees ONLY their own tenant's capabilities/usage — mirroring the
 * `/tenant/me` self-view. Global-admins manage other tenants via the
 * `/admin/entitlements/*` surface, not here (no silent global fallback).
 */
/**
 * TASK-758 — the counterpart to `/user/me/*`'s bound-user rule: the bare
 * "mine" surfaces resolve to the key's TENANT, via the CLS `tenantId` the
 * guard sets from `apiKeyEntity.tenantId`. Different resolution, so it gets
 * its own sentence rather than a shared one.
 */
const ME_IS_THE_KEY_TENANT = "Under API-key authentication this resolves to the key's **tenant**.";

@ApiTags('entitlements')
@ApiBearerAuth()
@Controller('entitlements')
// API-KEY-NOTE: policy A1. An integrator must be able to read the ceiling it
// is working against; sharing `tenant:account:read` with billing and usage
// keeps the three self-service reads one grant, not three.
@RequiredScopes('tenant:account:read')
export class MyEntitlementsController {
  constructor(
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get('me')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({
    summary: "Capability/usage snapshot for the caller's own tenant (limits, usage, meters, features, trial clock).",
    description: ME_IS_THE_KEY_TENANT,
  })
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
