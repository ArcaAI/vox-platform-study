import { TenantStorageConfigEntity } from '@arcaai/domains';
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
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
