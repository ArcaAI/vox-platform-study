/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantSttProviderCredentialEntity, TenantSttProviderCredentialEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantSttProviderCredentialProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantSttProviderCredentialEntity['tenantId'];
  provider: ITenantSttProviderCredentialEntity['provider'];
  endpoint?: ITenantSttProviderCredentialEntity['endpoint'];
  region?: ITenantSttProviderCredentialEntity['region'];
  encryptedApiKey?: ITenantSttProviderCredentialEntity['encryptedApiKey'];
  keyVersion?: ITenantSttProviderCredentialEntity['keyVersion'];
  enabled?: ITenantSttProviderCredentialEntity['enabled'];
  extraJson?: ITenantSttProviderCredentialEntity['extraJson'];

  createdAt?: ITenantSttProviderCredentialEntity['createdAt'];
  updatedAt?: ITenantSttProviderCredentialEntity['updatedAt'];
  createdBy?: ITenantSttProviderCredentialEntity['createdBy'];
  updatedBy?: ITenantSttProviderCredentialEntity['updatedBy'];
}

export class TenantSttProviderCredentialFactory {
  static CreateTenantSttProviderCredential(
    props: CreateTenantSttProviderCredentialProps,
  ): TenantSttProviderCredentialEntity {
    const id = generateId();
    const now = new Date();

    return new TenantSttProviderCredentialEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      provider: props.provider,
      endpoint: props.endpoint ?? null,
      region: props.region ?? null,
      encryptedApiKey: props.encryptedApiKey ?? null,
      keyVersion: props.keyVersion ?? null,
      enabled: props.enabled ?? false,
      extraJson: props.extraJson ?? null,
    });
  }
}
