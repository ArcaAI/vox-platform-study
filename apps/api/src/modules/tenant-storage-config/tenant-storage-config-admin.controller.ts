import { ITenantStorageConfigService, TenantStorageConfigResponse, UpsertTenantStorageConfigRequest } from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantOwnedResource } from '../../common';
import { CanAny, CanDelete, CanRead, CanUpdate } from '../../decorators';

/**
 * Admin API for per-tenant / per-bucket storage configuration (TASK-318 / R5).
 *
 * Tenant admins choose the backend (S3/MinIO or Azure) and topology
 * (SHARED → defer to the platform default; DEDICATED → tenant-owned credentials)
 * for their tenant, optionally overriding per bucket. The active tenant is taken
 * from the request context; the service scopes every read/write to it.
 *
 * Mirrors `TenantBucketController`: class-level
 * `@CanAny(['manage','Tenant'],['update','Tenant'])` gates the surface
 * (TASK-331 doc-04 F1 — tenant admins reach it via tenant-scoped
 * `update:Tenant`; GLOBAL_ADMIN via `manage:all`), method-level
 * `@Can*('Storage')` adds the specific operation (already granted to tenant
 * admins by `tenant-full-access`'s `manage:Storage`), and
 * `@TenantOwnedResource` guards the per-record delete route.
 */
@ApiBearerAuth()
@ApiTags('admin-storage-config')
@Controller('admin/tenants/storage/config')
@CanAny(['manage', 'Tenant'], ['update', 'Tenant'])
export class TenantStorageConfigAdminController {
  constructor(
    @Inject(ITenantStorageConfigService)
    private readonly storageConfigService: ITenantStorageConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List storage configs for the current tenant (default + per-bucket overrides)' })
  @ApiQuery({ name: 'includeDisabled', required: false, description: 'Include soft-deleted/disabled configs' })
  @ApiResponse({ status: 200, description: 'Tenant storage configurations' })
  @CanRead('Storage')
  async listConfigs(@Query('includeDisabled') includeDisabled?: string): Promise<TenantStorageConfigResponse[]> {
    return this.storageConfigService.listConfigs({ includeDisabled: includeDisabled === 'true' });
  }

  @Get('effective')
  @ApiOperation({ summary: 'Resolve the effective config for a bucket (per-bucket override → tenant default)' })
  @ApiQuery({ name: 'bucketId', required: false, description: 'Bucket id; omit to read the tenant default' })
  @ApiResponse({ status: 200, description: 'Effective storage configuration, or null when none is set' })
  @CanRead('Storage')
  async getEffectiveConfig(@Query('bucketId') bucketId?: string): Promise<TenantStorageConfigResponse | null> {
    return this.storageConfigService.getEffectiveConfig(bucketId);
  }

  @Put()
  @ApiOperation({ summary: 'Create or update a storage config (keyed by bucketId; omit for the tenant default)' })
  @ApiResponse({ status: 200, description: 'Stored storage configuration' })
  @CanUpdate('Storage')
  async upsertConfig(@Body() request: UpsertTenantStorageConfigRequest): Promise<TenantStorageConfigResponse> {
    return this.storageConfigService.upsertConfig(request);
  }

  @Delete(':id')
  @TenantOwnedResource({ modelName: 'TenantStorageConfig', paramName: 'id' })
  @ApiOperation({ summary: 'Delete a storage config (reverts that scope to the next-broader config / global)' })
  @ApiParam({ name: 'id', description: 'Storage config ID' })
  @ApiResponse({ status: 200, description: 'Deleted storage configuration' })
  @CanDelete('Storage')
  async deleteConfig(@Param('id') id: string): Promise<TenantStorageConfigResponse> {
    return this.storageConfigService.deleteConfig(id);
  }
}
