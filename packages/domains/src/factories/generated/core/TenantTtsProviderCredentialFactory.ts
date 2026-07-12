/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantTtsProviderCredentialEntity, TenantTtsProviderCredentialEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantTtsProviderCredentialProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantTtsProviderCredentialEntity['tenantId'];
  provider: ITenantTtsProviderCredentialEntity['provider'];
  endpoint?: ITenantTtsProviderCredentialEntity['endpoint'];
  encryptedApiKey?: ITenantTtsProviderCredentialEntity['encryptedApiKey'];
  keyVersion?: ITenantTtsProviderCredentialEntity['keyVersion'];
  enabled?: ITenantTtsProviderCredentialEntity['enabled'];

  createdAt?: ITenantTtsProviderCredentialEntity['createdAt'];
  updatedAt?: ITenantTtsProviderCredentialEntity['updatedAt'];
  createdBy?: ITenantTtsProviderCredentialEntity['createdBy'];
  updatedBy?: ITenantTtsProviderCredentialEntity['updatedBy'];
}

export class TenantTtsProviderCredentialFactory {
  static CreateTenantTtsProviderCredential(
    props: CreateTenantTtsProviderCredentialProps,
  ): TenantTtsProviderCredentialEntity {
    const id = generateId();
    const now = new Date();

    return new TenantTtsProviderCredentialEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      provider: props.provider,
      endpoint: props.endpoint ?? null,
      encryptedApiKey: props.encryptedApiKey ?? null,
      keyVersion: props.keyVersion ?? null,
      enabled: props.enabled ?? false,
    });
  }
}
