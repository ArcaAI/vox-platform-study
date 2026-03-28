import {
  ITenantService,
  TenantResponse,
  TenantDtoMapper,
  PaginatedTenantConfigResponse,
  GlobalSettingDtoMapper,
  IActiveUserContext,
  UpdateTenantConfigRequest,
} from '@arcaai/applications';
import { Controller, Get, Patch, Body, Inject, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';

const GLOBAL_TENANT_KEY = '__GLOBAL__';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

@ApiBearerAuth()
@ApiTags('tenant')
@Controller('tenant')
@Authorize()
export class MyTenantController {
  constructor(
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current tenant information' })
  @ApiResponse({ status: 200, description: 'Tenant information retrieved successfully', type: TenantResponse })
  @ApiResponse({ status: 401, description: 'Unauthorized - no tenant context' })
  async me(): Promise<TenantResponse> {
    const tenantId = await this.resolveTenantId();
    const result = await this.tenantService.fetchById(tenantId);
    return TenantDtoMapper.ToResponse(result);
  }

  @Get('me/config')
  @ApiOperation({ summary: 'Get current tenant configuration' })
  @ApiResponse({ status: 200, description: 'Tenant configuration retrieved successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 401, description: 'Unauthorized - no tenant context' })
  async myConfig(): Promise<PaginatedTenantConfigResponse> {
    const tenantId = await this.resolveTenantId();
    const result = await this.tenantService.fetchTenantConfigs({ tenantId, limit: 200, page: 1 });
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  @Patch('me/config')
  @ApiOperation({ summary: 'Update current tenant configuration' })
  @ApiResponse({ status: 200, description: 'Tenant configuration updated successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 401, description: 'Unauthorized - no tenant context' })
  async updateMyConfig(@Body() configs: UpdateTenantConfigRequest[]): Promise<PaginatedTenantConfigResponse> {
    const tenantId = await this.resolveTenantId();
    const result = await this.tenantService.updateTenantConfigs(tenantId, configs);
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  private async resolveTenantId(): Promise<string> {
    const tenantId = this.clsService.get('tenantId');
    if (tenantId) return tenantId;

    const user = this.clsService.get('user') as { roles?: string[] } | undefined;
    if (user?.roles?.includes(SUPER_ADMIN_ROLE)) {
      const globalTenant = await this.tenantService.fetchByCodeName(GLOBAL_TENANT_KEY);
      return globalTenant.id;
    }

    throw new UnauthorizedException('No tenant context available');
  }
}
