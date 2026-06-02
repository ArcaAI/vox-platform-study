import {
  CreateTenantBucketRequest,
  DeleteTenantBucketObjectResponse,
  ITenantBucketService,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
  TenantBucketResponse,
  TenantBucketTreeResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantOwnedResource } from '../../common';
import { CanCreate, CanDelete, CanManage, CanRead, CanUpdate } from '../../decorators';

@ApiBearerAuth()
@ApiTags('tenant-storage')
@Controller('admin/tenants/storage/buckets')
// Phase 0 Item 3 (TASK-302 Stream A): explicit permission required.
@CanManage('Tenant')
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

  // NOTE: declared before `@Get(':id')` so the literal `defaults` segment is not
  // captured by the `:id` param route.
  @Get('defaults')
  @ApiOperation({ summary: 'Get the default bucket for each purpose (audio / attachments / misc)' })
  @ApiResponse({ status: 200, description: 'Default buckets per purpose' })
  @CanRead('Storage')
  async getDefaultBuckets(): Promise<TenantBucketDefaultsResponse> {
    return this.tenantBucketService.getDefaultBuckets();
  }

  @Put('defaults')
  @ApiOperation({ summary: 'Configure the default bucket for audio / attachments / misc' })
  @ApiResponse({ status: 200, description: 'Updated default buckets per purpose' })
  @CanUpdate('Storage')
  async setDefaultBuckets(@Body() request: SetTenantBucketDefaultsRequest): Promise<TenantBucketDefaultsResponse> {
    return this.tenantBucketService.setDefaultBuckets(request);
  }

  @Get(':id')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
  @ApiOperation({ summary: 'Get bucket by ID' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiResponse({ status: 200, description: 'Bucket details' })
  @CanRead('Storage')
  async getBucket(@Param('id') id: string): Promise<TenantBucketResponse | null> {
    return this.tenantBucketService.getBucketById(id);
  }

  @Get(':id/tree')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
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
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
  @ApiOperation({ summary: 'Delete a custom storage bucket (system buckets cannot be deleted)' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiResponse({ status: 200, description: 'Bucket deleted' })
  @CanDelete('Storage')
  async deleteBucket(@Param('id') id: string): Promise<TenantBucketResponse> {
    return this.tenantBucketService.deleteBucket(id);
  }

  @Delete(':id/objects')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
  @ApiOperation({ summary: 'Delete a single object from a tenant bucket (storage-provider operation)' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiQuery({ name: 'key', description: 'Object key/path to delete (e.g. 2026/04/08/streaming/file.wav)', required: true })
  @ApiResponse({ status: 200, description: 'Object deleted', type: DeleteTenantBucketObjectResponse })
  @CanDelete('Storage')
  async deleteObject(@Param('id') id: string, @Query('key') key: string): Promise<DeleteTenantBucketObjectResponse> {
    return this.tenantBucketService.deleteObject(id, key);
  }

  @Post('provision/:tenantId')
  @ApiOperation({ summary: 'Provision system buckets for a tenant (admin only)' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID to provision buckets for' })
  @ApiResponse({ status: 201, description: 'System buckets provisioned' })
  @CanManage('Tenant')
  async provisionSystemBuckets(@Param('tenantId') tenantId: string): Promise<TenantBucketResponse[]> {
    return this.tenantBucketService.provisionSystemBuckets(tenantId);
  }

  @Get(':id/presigned-url')
  @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
  @ApiOperation({ summary: 'Get presigned download URL for a file in a tenant bucket' })
  @ApiParam({ name: 'id', description: 'Bucket ID' })
  @ApiQuery({ name: 'key', description: 'File key/path (e.g. 2026/04/08/streaming/file.wav)', required: true })
  @ApiResponse({ status: 200, description: 'Presigned download URL' })
  @CanRead('Storage')
  async getPresignedUrl(@Param('id') id: string, @Query('key') key: string): Promise<{ url: string }> {
    return this.tenantBucketService.getPresignedUrl(id, key);
  }
}
