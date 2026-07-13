import { Body, Controller, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  HttpMethod,
  IActiveUserContext,
  ITenantOnboardingService,
  ProvisionTenantRequest,
  TenantAdminSpec,
  TenantOnboardingDtoMapper,
  TenantProvisionResponse,
} from '@arcaai/applications';
import { ApiEndpoint, CanManage } from '../../decorators';

/**
 * TASK-497 §3.5 — global-admin create-tenant-with-admin. A SEPARATE
 * controller/route (`POST /admin/tenants/provision`) rather than extending
 * `TenantController.create`: keeps the existing `POST /admin/tenants`
 * (tenant-only, no admin block) untouched — zero risk to its callers/tests —
 * while giving the admin-console a dedicated "full provision" endpoint.
 */
@ApiBearerAuth()
@ApiTags('admin-tenants')
@Controller('admin/tenants')
export class TenantProvisionController {
  constructor(
    @Inject(ITenantOnboardingService) private readonly tenantOnboardingService: ITenantOnboardingService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @ApiEndpoint({
    returnedModel: TenantProvisionResponse,
    method: HttpMethod.POST,
    path: 'provision',
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  // Same posture as TenantController.create — creating tenants (with or
  // without an admin) is a GLOBAL_ADMIN-only, privilege-escalation-adjacent
  // operation.
  @CanManage('Tenant')
  async provision(@Body() request: ProvisionTenantRequest): Promise<TenantProvisionResponse> {
    const user = this.cls.get('user');

    const admin: TenantAdminSpec =
      request.admin.mode === 'existing'
        ? { kind: 'existing', userId: request.admin.userId as string }
        : {
            kind: 'new-local',
            email: request.admin.email as string,
            username: request.admin.username,
            password: request.admin.password as string,
          };

    const result = await this.tenantOnboardingService.provisionTenantWithAdmin({
      tenantName: request.tenantName,
      tenantKey: request.tenantKey,
      plan: request.plan,
      admin,
      actor: { userId: user?.id as string, tenantId: user?.tenantId ?? '' },
    });

    return TenantOnboardingDtoMapper.ToResponse(result);
  }
}
