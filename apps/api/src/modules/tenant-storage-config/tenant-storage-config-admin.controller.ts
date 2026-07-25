import {
  ITenantStorageConfigService,
  TenantStorageConfigResponse,
  UpsertPlatformStorageConfigRequest,
  UpsertTenantStorageConfigRequest,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantOwnedResource } from '../../common';
import { CanAny, CanDelete, CanRead, CanUpdate, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * Admin API for per-tenant / per-bucket storage configuration.
 *
 * Tenant admins choose the backend (S3/MinIO or Azure) and topology
 * (SHARED → defer to the platform default; DEDICATED → tenant-owned credentials)
 * for their tenant, optionally overriding per bucket. The active tenant is taken
 * from the request context; the service scopes every read/write to it.
 *
 * Mirrors `TenantBucketController`: class-level
 * `@CanAny(['manage','Tenant'],['update','Tenant'])` gates the surface
 * (tenant admins reach it via tenant-scoped
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

  // AUTH-NOTE: the two `platform` routes below manage the SYSTEM-tenant
  // storage row — the platform default every tenant falls back to. They are
  // GLOBAL_ADMIN-ONLY, enforced IMPERATIVELY in
  // `TenantStorageConfigService.assertGlobalAdmin` (→ 403), because the
  // permission decorators express `action + subject` and cannot express
  // "global admins only": a tenant admin legitimately holds `manage:Storage`
  // for its OWN rows and reaches this controller through the class-level
  // `update:Tenant`. The handler decorators below therefore UNDERSTATE the real
  // gate — do not widen either without reading the service first. This is a 403
  // privilege boundary, NOT the 404-over-403 cross-tenant posture (a
  // cross-tenant config id still returns 404 on the routes above).
  // The matching `storage.platformDefault.*` descriptors carry `globalOnly: true`.
  @Get('platform')
  @ApiOperation({
    summary: 'Read the platform-default storage config (SYSTEM row) — GLOBAL_ADMIN only',
    description:
      'The third tier of the resolution order (bucket → tenant default → SYSTEM default → env). Returns a `version: 0` ' +
      'placeholder when the row has not been created yet, so the client can `If-Match: "0"` to create it. ' +
      '`credentialsRef` is a Vault path, never the credentials.',
  })
  @ApiResponse({ status: 200, type: TenantStorageConfigResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @CanRead('Storage')
  async getPlatformDefault(): Promise<TenantStorageConfigResponse> {
    return this.storageConfigService.getPlatformDefault();
  }

  @Put('platform')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update the platform-default storage config under optimistic concurrency — GLOBAL_ADMIN only',
    description:
      'Takes effect for every tenant on the NEXT file operation — no redeploy — because the write busts the process-wide ' +
      'platform provider cache. `If-Match` (RFC 7232) carries the version read from the prior GET: `"0"` creates the row, ' +
      'an existing version CASes against `_version` (drift → 412, missing → 428). Credentials are never accepted here; ' +
      'set `credentialsRef` to the Vault kv-v2 path that holds them.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: TenantStorageConfigResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a global administrator.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  @CanUpdate('Storage')
  async upsertPlatformDefault(
    @Body() request: UpsertPlatformStorageConfigRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<TenantStorageConfigResponse> {
    return this.storageConfigService.upsertPlatformDefault({
      ...request,
      expectedVersion: expectedFromHeader ?? request.expectedVersion,
    });
  }

  @Get('effective')
  @ApiOperation({ summary: 'Resolve the effective config for a bucket (per-bucket override → tenant default → SYSTEM default)' })
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
