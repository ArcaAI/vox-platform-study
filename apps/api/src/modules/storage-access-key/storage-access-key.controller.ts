import {
  IStorageAccessKeyService,
  StorageAccessKeyResponse,
  StorageAccessKeyWithSecretResponse,
  CreateStorageAccessKeyRequest,
} from '@arcaai/applications';
import { Controller, Body, Param, Inject, Delete, Get, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiParam, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CanCreate, CanDelete, CanManage, CanRead, RequiredScopes } from '../../decorators';

@ApiBearerAuth()
@ApiTags('tenant-storage-keys')
@RequiredScopes('admin:storage-key:manage')
@Controller('admin/tenants/storage/keys')
@CanManage('Tenant')
export class StorageAccessKeyController {
  constructor(
    @Inject(IStorageAccessKeyService)
    private readonly storageAccessKeyService: IStorageAccessKeyService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all storage access keys for current tenant' })
  @ApiResponse({ status: 200, description: 'List of access keys (secrets not included)' })
  @CanRead('Storage')
  async listKeys(): Promise<StorageAccessKeyResponse[]> {
    return this.storageAccessKeyService.listKeys();
  }

  @Post()
  @ApiOperation({ summary: 'Generate a new storage access key' })
  @ApiResponse({ status: 201, description: 'Key created (secret shown only once)' })
  @CanCreate('Storage')
  async generateKey(@Body() request: CreateStorageAccessKeyRequest): Promise<StorageAccessKeyWithSecretResponse> {
    return this.storageAccessKeyService.generateKey(request);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a storage access key' })
  @ApiParam({ name: 'id', description: 'Key ID' })
  @ApiResponse({ status: 200, description: 'Key revoked' })
  @CanDelete('Storage')
  async revokeKey(@Param('id') id: string): Promise<StorageAccessKeyResponse> {
    return this.storageAccessKeyService.revokeKey(id);
  }
}
