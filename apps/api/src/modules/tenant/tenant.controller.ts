import {
  ITenantService,
  PaginatedQuery,
  TenantResponse,
  CreateTenantRequest,
  PaginatedTenantResponse,
  UpdateTenantRequest,
  TenantDtoMapper,
  HttpMethod,
  PaginatedTenantConfigResponse,
  GlobalSettingDtoMapper,
  UpdateTenantConfigRequest,
} from '@arcaai/applications';
import { Controller, Body, Param, Get, Inject, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiEndpoint, CanManage } from '../../decorators';
import { TenantUsageResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-tenants')
@Controller('admin/tenants')
@CanManage('Tenant')
export class TenantController {
  constructor(
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
  ) {}

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  async create(@Body() request: CreateTenantRequest): Promise<TenantResponse> {
    const result = await this.tenantService.create(request);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    const result = await this.tenantService.fetchAll({
      ...queryParams,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: 'user/:userId',
    multi: true,
    by: ['createdByUserId'],
  })
  @ApiParam({ name: 'userId', description: 'User ID', type: String })
  async fetchByUserId(@Param('userId') userId: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantResponse> {
    const result = await this.tenantService.fetchAllCreatedByUser({
      ...queryParams,
      userId,
    });
    return TenantDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant usage statistics' })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 200, description: 'Tenant usage statistics', type: TenantUsageResponse })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async getUsage(@Param('id') id: string): Promise<TenantUsageResponse> {
    return this.tenantService.getUsageStats(id);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async fetchById(@Param('id') id: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    path: 'code-name/:code-name',
    by: ['code-name'],
  })
  @ApiParam({ name: 'code-name', description: 'Tenant code name', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async fetchByCodeName(@Param('code-name') codeName: string): Promise<TenantResponse> {
    const result = await this.tenantService.fetchByCodeName(codeName);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async update(@Param('id') id: string, @Body() request: UpdateTenantRequest): Promise<TenantResponse> {
    const result = await this.tenantService.update(id, request);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: TenantResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Tenant ID', type: String })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  async delete(@Param('id') id: string): Promise<TenantResponse> {
    const result = await this.tenantService.deleteById(id);
    return TenantDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    path: 'configs/:identifier',
    by: ['identifier'],
    multi: true,
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  async fetchTenantConfigs(@Param('identifier') identifier: string, @Query() queryParams: PaginatedQuery): Promise<PaginatedTenantConfigResponse> {
    const result = await this.tenantService.fetchTenantConfigs({
      ...queryParams,
      tenantId: identifier,
      codeName: identifier,
    });
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }

  @ApiEndpoint({
    returnedModel: PaginatedTenantConfigResponse,
    method: HttpMethod.PATCH,
    path: '/configs/:identifier',
    by: ['identifier'],
  })
  @ApiParam({ name: 'identifier', description: 'Tenant ID or code name', type: String })
  @ApiResponse({ status: 400, description: 'Bad request - invalid config data' })
  async updateTenantConfigs(
    @Param('identifier') identifier: string,
    @Body() configs: UpdateTenantConfigRequest[],
  ): Promise<PaginatedTenantConfigResponse> {
    const result = await this.tenantService.updateTenantConfigs(identifier, configs);
    return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
  }
}
