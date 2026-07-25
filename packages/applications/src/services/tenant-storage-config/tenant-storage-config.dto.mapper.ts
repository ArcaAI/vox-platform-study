import { StorageProviderType, StorageTopologyType, SYSTEM_TENANT_ID, TenantStorageConfigEntity } from '@arcaai/domains';
import { TenantStorageConfigResponse } from './dto';

export class TenantStorageConfigDtoMapper {
  static toResponse(entity: TenantStorageConfigEntity): TenantStorageConfigResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId as string,
      bucketId: entity.bucketId ?? null,
      provider: entity.provider,
      topology: entity.topology,
      endpoint: entity.endpoint ?? null,
      region: entity.region ?? null,
      forcePathStyle: entity.forcePathStyle ?? null,
      accountName: entity.accountName ?? null,
      endpointSuffix: entity.endpointSuffix ?? null,
      containerPrefix: entity.containerPrefix ?? null,
      credentialsRef: entity.credentialsRef ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  /**
   * The "not created yet" platform default. `version: 0` is the OCC token a
   * client sends back as `If-Match: "0"` to CREATE the SYSTEM row — the same
   * placeholder contract `TenantTtsConfigDtoMapper.placeholder` uses.
   */
  static platformPlaceholder(): TenantStorageConfigResponse {
    const now = new Date().toISOString();
    return {
      id: '',
      tenantId: SYSTEM_TENANT_ID,
      bucketId: null,
      provider: StorageProviderType.MINIO,
      topology: StorageTopologyType.SHARED,
      endpoint: null,
      region: null,
      forcePathStyle: null,
      accountName: null,
      endpointSuffix: null,
      containerPrefix: null,
      credentialsRef: null,
      resourceStatus: undefined,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}
