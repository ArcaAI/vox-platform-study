import { ITenantBucketService, TenantBucketResponse, CreateTenantBucketRequest, TenantBucketTreeResponse } from '@arcaai/applications';
import { Controller, Body, Param, Inject, Delete, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Authorize, CanRead, CanCreate, CanDelete, CanManage } from '../../decorators';

@ApiBearerAuth()
@ApiTags('tenant-storage')
@Controller('admin/tenants/storage/buckets')
@Authorize()
export class TenantBucketController {
  constructor(
    @Inject(ITenantBucketService)
    private readonly tenantBucketService: ITenantBucketService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all storage buckets for current tenant' })
  @ApiResponse({ status: 200, description: 'List of tenant buckets' })
  @CanRead('Storage')
  async listBuckets(): Promise<TenantBucketResponse[]> {
    return this.tenantBucketService.listBuckets();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get bucket by ID' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiResponse({ status: 200, description: 'Bucket details' })
  @CanRead('Storage')
  async getBucket(@Param('id') id: string): Promise<TenantBucketResponse | null> {
    return this.tenantBucketService.getBucketById(id);
  }

  @Get(':id/tree')
  @ApiOperation({ summary: 'Get bucket folder/file tree for UI tree view' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiQuery({
    name: 'prefix',
    required: false,
    description: 'Optional root path to build tree from',
  })
  @ApiResponse({ status: 200, description: 'Bucket tree payload for UI' })
  @CanRead('Storage')
  async getBucketTree(@Param('id') id: string, @Query('prefix') prefix?: string): Promise<TenantBucketTreeResponse> {
    return this.tenantBucketService.getBucketTree(id, prefix ?? '');
  }

  @Post()
  @ApiOperation({ summary: 'Create a custom storage bucket' })
  @ApiResponse({ status: 201, description: 'Bucket created' })
  @CanCreate('Storage')
  async createBucket(@Body() request: CreateTenantBucketRequest): Promise<TenantBucketResponse> {
    return this.tenantBucketService.createCustomBucket(request);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a custom storage bucket (system buckets cannot be deleted)' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiResponse({ status: 200, description: 'Bucket deleted' })
  @CanDelete('Storage')
  async deleteBucket(@Param('id') id: string): Promise<TenantBucketResponse> {
    return this.tenantBucketService.deleteBucket(id);
  }

  @Post('provision/:tenantId')
  @ApiOperation({ summary: 'Provision system buckets for a tenant (admin only)' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID to provision buckets for' })
  @ApiResponse({ status: 201, description: 'System buckets provisioned' })
  @CanManage('Tenant')
  async provisionSystemBuckets(@Param('tenantId') tenantId: string): Promise<TenantBucketResponse[]> {
    return this.tenantBucketService.provisionSystemBuckets(tenantId);
  }
}
