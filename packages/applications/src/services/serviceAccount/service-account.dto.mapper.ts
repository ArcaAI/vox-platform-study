import { ServiceAccountEntity } from '@arcaai/domains';
import { ServiceAccountResponse, ServiceAccountSecretResponse } from './dto';
import { ServiceAccountService } from './service-account.service';

/**
 * Entity → Response DTO. The load-bearing property of this mapper is what it
 * does NOT copy: `secretVerifier` and `previousSecretVerifier` never appear on
 * any response shape, so a read can never surface credential material even
 * indirectly. `credentialsRef` IS surfaced — it is a Vault PATH, not a value.
 */
export class ServiceAccountDtoMapper {
  static toResponse(entity: ServiceAccountEntity): ServiceAccountResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      clientId: entity.clientId,
      displayName: entity.displayName,
      description: entity.description ?? null,
      scopes: entity.scopes,
      allowedTenantIds: entity.allowedTenantIds ?? null,
      allowedIps: entity.allowedIps ?? null,
      superAdmin: entity.superAdmin,
      tokenTtlSeconds: entity.tokenTtlSeconds,
      credentialsRef: entity.credentialsRef,
      rotationOverlapActive: entity.isRotationOverlapActive(),
      previousCredentialExpiresAt: entity.previousCredentialExpiresAt?.toISOString() ?? null,
      rotatedAt: entity.rotatedAt?.toISOString() ?? null,
      lastUsedAt: entity.lastUsedAt?.toISOString() ?? null,
      resourceStatus: String(entity.resourceStatus),
      version: entity.version,
      createdAt: entity.createdAt?.toISOString() ?? new Date(0).toISOString(),
      updatedAt: entity.updatedAt?.toISOString() ?? new Date(0).toISOString(),
    };
  }

  /**
   * The ONE shape carrying the plaintext secret — create and rotate only. The
   * secret is not persisted in a recoverable form anywhere, so this response is
   * the only opportunity the caller will ever have to capture it.
   */
  static toSecretResponse(entity: ServiceAccountEntity, clientSecret: string): ServiceAccountSecretResponse {
    return {
      ...ServiceAccountDtoMapper.toResponse(entity),
      clientSecret,
      provisionAt: ServiceAccountService.credentialsRefFor(entity.clientId, 'current'),
    };
  }
}
