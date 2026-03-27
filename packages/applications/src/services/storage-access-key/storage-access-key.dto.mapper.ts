import { StorageAccessKeyEntity } from '@arcaai/domains';
import { StorageAccessKeyResponse, StorageAccessKeyWithSecretResponse } from './dto';

export class StorageAccessKeyDtoMapper {
  static toResponse(entity: StorageAccessKeyEntity): StorageAccessKeyResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId as string,
      name: entity.name,
      description: entity.description ?? undefined,
      accessKeyId: entity.accessKeyId,
      permissions: entity.permissions,
      bucketIds: entity.bucketIds,
      expiresAt: entity.expiresAt?.toISOString(),
      lastUsedAt: entity.lastUsedAt?.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }

  static toResponseWithSecret(entity: StorageAccessKeyEntity): StorageAccessKeyWithSecretResponse {
    return {
      ...this.toResponse(entity),
      secretAccessKey: entity.secretAccessKey,
    };
  }
}
