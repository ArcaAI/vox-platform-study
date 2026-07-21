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

  /**
   * The persisted `entity.secretAccessKey` is only a HASH,
   * so the one-time plaintext secret must be supplied explicitly by the caller
   * (the service, at creation time). It is never read back from the entity.
   */
  static toResponseWithSecret(entity: StorageAccessKeyEntity, plaintextSecret: string): StorageAccessKeyWithSecretResponse {
    return {
      ...this.toResponse(entity),
      secretAccessKey: plaintextSecret,
    };
  }
}
