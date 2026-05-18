import {
  ITenantService,
  TenantResponse,
  TenantDtoMapper,
  PaginatedTenantConfigResponse,
  GlobalSettingDtoMapper,
  IActiveUserContext,
  UpdateTenantConfigRequest,
} from '@arcaai/applications';
import { Controller, Get, Patch, Body, Inject, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';

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

  /**
   * Returns the tenant entity associated with the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present — super-admins must use
   * the /admin/tenants endpoints to manage other tenants instead of relying on a
   * silent global fallback.
   */
  @Get('me')
  @ApiOperation({ summary: 'Get current tenant information' })
  @ApiResponse({ status: 200, description: 'Tenant information retrieved successfully', type: TenantResponse })
  @ApiResponse({ status: 400, description: 'Bad request - no tenant context' })
  async me(): Promise<TenantResponse> {
    const tenantId = this.resolveTenantId();
    const result = await this.tenantService.fetchById(tenantId);
    return TenantDtoMapper.ToResponse(result);
  }

  /**
   * Returns the configuration rows for the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present (no silent global
   * fallback for super-admins).
   */
  @Get('me/config')
  @ApiOperation({ summary: 'Get current tenant configuration' })
  @ApiResponse({ status: 200, description: 'Tenant configuration retrieved successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 400, description: 'Bad request - no tenant context' })
  async myConfig(): Promise<PaginatedTenantConfigResponse> {
    const tenantId = this.resolveTenantId();
    const result = await this.tenantService.fetchTenantConfigs({ tenantId, limit: 200, page: 1 });
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  /**
   * Updates configuration rows for the caller's CLS tenant context.
   * Responds with 400 when no tenant context is present (no silent global
   * fallback for super-admins).
   */
  @Patch('me/config')
  @ApiOperation({ summary: 'Update current tenant configuration' })
  @ApiResponse({ status: 200, description: 'Tenant configuration updated successfully', type: PaginatedTenantConfigResponse })
  @ApiResponse({ status: 400, description: 'Bad request - no tenant context' })
  async updateMyConfig(@Body() configs: UpdateTenantConfigRequest[]): Promise<PaginatedTenantConfigResponse> {
    const tenantId = this.resolveTenantId();
    const result = await this.tenantService.updateTenantConfigs(tenantId, configs);
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  private resolveTenantId(): string {
    const tenantId = this.clsService.get('tenantId');
    if (tenantId) return tenantId;

    throw new BadRequestException('Tenant context is required. Super-admins must use /admin/tenants endpoints to manage other tenants.');
  }
}
