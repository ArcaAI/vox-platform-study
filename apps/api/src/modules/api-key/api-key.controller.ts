import {
  ApiKeyDtoMapper,
  ApiKeyResponse,
  CreateApiKeyRequest,
  getScopesByCategory,
  HttpMethod,
  IActiveUserContext,
  IApiKeyService,
  PaginatedApiKeyResponse,
  PaginatedQuery,
  UpdateApiKeyRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { ApiEndpoint, CanCreate, CanManage, CanRead, CanUpdate, CanDelete, RequiredScopes } from '../../decorators';
import { CreateApiKeyResponse, ApiKeyUsageResponse } from './dto';

@ApiBearerAuth()
@ApiTags('admin-api-keys')
@RequiredScopes('admin:apikey:write')
@Controller('admin/api-keys')
@CanManage('ApiKey')
export class ApiKeyController {
  constructor(
    @Inject(IApiKeyService)
    private readonly apiKeyService: IApiKeyService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  @Get('scopes')
  @ApiOperation({ summary: 'List available API key scopes' })
  @ApiResponse({ status: 200, description: 'Available scopes grouped by category' })
  @CanRead('ApiKey')
  getAvailableScopes() {
    return getScopesByCategory();
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
  })
  @ApiResponse({ status: 201, description: 'API key created. Raw key returned only once.', type: CreateApiKeyResponse })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @CanCreate('ApiKey')
  async create(@Body() request: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    const result = await this.apiKeyService.create(request);
    return {
      apiKey: ApiKeyDtoMapper.ToResponse(result.apiKey),
      rawKey: result.rawKey,
    };
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    multi: true,
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @CanRead('ApiKey')
  async fetchAll(@Query() queryParams: PaginatedQuery): Promise<PaginatedApiKeyResponse> {
    const tenantId = this.clsService.get('tenantId');
    const result = tenantId
      ? await this.apiKeyService.fetchAllByTenantId({
          ...queryParams,
          tenantId,
          sort: queryParams.sort || 'updatedAt:desc',
        })
      : await this.apiKeyService.fetchAll({
          ...queryParams,
          sort: queryParams.sort || 'updatedAt:desc',
        });
    return ApiKeyDtoMapper.ToPaginatedResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanRead('ApiKey')
  async fetchById(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.fetchById(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.PATCH,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  async update(@Param('id') id: string, @Body() request: UpdateApiKeyRequest): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.update(id, request);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.DELETE,
    path: '/:id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanDelete('ApiKey')
  async delete(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.deleteById(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
    path: ':id/revoke',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  async revoke(@Param('id') id: string): Promise<ApiKeyResponse> {
    const result = await this.apiKeyService.revokeKey(id);
    return ApiKeyDtoMapper.ToResponse(result);
  }

  // Rotate: mint a NEW key inheriting the old key's config,
  // link old→new, and (per the pre-existing service) keep BOTH valid for a 24h
  // grace window (`rotationExpiresAt`) rather than invalidating immediately.
  // The new raw key is returned exactly ONCE (same contract as create).
  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    method: HttpMethod.POST,
    path: ':id/rotate',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({
    status: 201,
    description: 'API key rotated. New raw key returned only once; old key stays valid for a 24h grace window.',
    type: CreateApiKeyResponse,
  })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanUpdate('ApiKey')
  async rotate(@Param('id') id: string): Promise<CreateApiKeyResponse> {
    const result = await this.apiKeyService.rotateKey(id);
    return {
      apiKey: ApiKeyDtoMapper.ToResponse(result.newApiKey),
      rawKey: result.newRawKey,
    };
  }

  @ApiEndpoint({
    returnedModel: ApiKeyResponse,
    path: ':id/usage',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'API Key ID', type: String })
  @ApiResponse({ status: 200, description: 'API key usage statistics', type: ApiKeyUsageResponse })
  @ApiResponse({ status: 404, description: 'API key not found' })
  @CanRead('ApiKey')
  async getUsage(@Param('id') id: string): Promise<ApiKeyUsageResponse> {
    const apiKey = await this.apiKeyService.fetchById(id);
    const mapped = ApiKeyDtoMapper.ToResponse(apiKey);
    return {
      totalCalls: mapped.usageCount ?? 0,
      lastUsedAt: mapped.lastUsedAt ?? null,
      rateLimit: mapped.rateLimit ?? 0,
    };
  }
}
