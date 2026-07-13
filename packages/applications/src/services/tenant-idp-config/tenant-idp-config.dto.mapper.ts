import { TenantIdentityProviderEntity } from '@arcaai/domains';
import { OidcProviderConfigDto, SamlProviderConfigDto, TenantIdpConfigResponse } from './dto';

export class TenantIdpConfigDtoMapper {
  static toResponse(entity: TenantIdentityProviderEntity): TenantIdpConfigResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      protocol: entity.protocol,
      displayName: entity.displayName,
      providerStatus: entity.providerStatus,
      config: entity.config as unknown as OidcProviderConfigDto | SamlProviderConfigDto,
      hasSecret: Boolean(entity.encryptedSecretRef),
      hasDirectoryCredentials: Boolean(entity.directoryCredentialsRef),
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }
}
