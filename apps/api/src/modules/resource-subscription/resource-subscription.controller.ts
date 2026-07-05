import {
  CreateResourceSubscriptionRequest,
  IResourceSubscriptionService,
  PaginatedQuery,
  PaginatedResourceSubscriptionResponse,
  ResourceSubscriptionDtoMapper,
  ResourceSubscriptionResponse,
  UpdateResourceSubscriptionRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage } from '../../decorators';

/**
 * ResourceSubscriptionController (TASK-419 item 2) — admin CRUD + toggle
 * surface over the pre-existing `ResourceSubscriptionService`, mounted at
 * `/admin/resource-subscriptions`.
 *
 * Update is a plain sparse patch (non-CAS service write — no If-Match); the
 * toggle flips `resourceStatus` ENABLED↔DISABLED. Tenancy is service-enforced.
 * CASL: class-level `manage:ResourceSubscription` (tenant-full-access grants
 * it tenant-scoped; `user-profile-own` covers own-subscription flows).
 */
@ApiBearerAuth()
@ApiTags('admin-resource-subscriptions')
@Controller('admin/resource-subscriptions')
@CanManage('ResourceSubscription')
export class ResourceSubscriptionController {
  constructor(
    @Inject(IResourceSubscriptionService)
    private readonly resourceSubscriptionService: IResourceSubscriptionService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a resource subscription' })
  @ApiResponse({ status: 201, type: ResourceSubscriptionResponse })
  @ApiResponse({ status: 400, description: 'Bad request — invalid input.' })
  async create(@Body() request: CreateResourceSubscriptionRequest): Promise<ResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.create(request);
    return ResourceSubscriptionDtoMapper.ToResponse(result);
  }

  @Get()
  @ApiOperation({ summary: 'List resource subscriptions (tenant-scoped)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: PaginatedResourceSubscriptionResponse })
  async fetchAll(@Query() query: PaginatedQuery): Promise<PaginatedResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.fetchAll({ ...query, sort: query.sort || 'createdAt:desc' });
    return ResourceSubscriptionDtoMapper.ToPaginatedResponse(result);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one resource subscription' })
  @ApiParam({ name: 'id', description: 'Resource subscription id' })
  @ApiResponse({ status: 200, type: ResourceSubscriptionResponse })
  @ApiResponse({ status: 404, description: 'Resource subscription not found (or cross-tenant).' })
  async fetchById(@Param('id') id: string): Promise<ResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.fetchById(id);
    return ResourceSubscriptionDtoMapper.ToResponse(result);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a resource subscription (sparse patch)' })
  @ApiParam({ name: 'id', description: 'Resource subscription id' })
  @ApiResponse({ status: 200, type: ResourceSubscriptionResponse })
  @ApiResponse({ status: 404, description: 'Resource subscription not found (or cross-tenant).' })
  async update(@Param('id') id: string, @Body() request: UpdateResourceSubscriptionRequest): Promise<ResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.update(id, request);
    return ResourceSubscriptionDtoMapper.ToResponse(result);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle a subscription ENABLED↔DISABLED' })
  @ApiParam({ name: 'id', description: 'Resource subscription id' })
  @ApiResponse({ status: 201, type: ResourceSubscriptionResponse })
  @ApiResponse({ status: 404, description: 'Resource subscription not found (or cross-tenant).' })
  async toggle(@Param('id') id: string): Promise<ResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.toggleSubscriptionById(id);
    return ResourceSubscriptionDtoMapper.ToResponse(result);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a resource subscription' })
  @ApiParam({ name: 'id', description: 'Resource subscription id' })
  @ApiResponse({ status: 200, type: ResourceSubscriptionResponse })
  @ApiResponse({ status: 404, description: 'Resource subscription not found (or cross-tenant).' })
  async delete(@Param('id') id: string): Promise<ResourceSubscriptionResponse> {
    const result = await this.resourceSubscriptionService.deleteById(id);
    return ResourceSubscriptionDtoMapper.ToResponse(result);
  }
}
