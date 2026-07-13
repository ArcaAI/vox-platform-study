/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantIdentityProviderEntity, TenantIdentityProviderEntity } from '../../../entities';
import { IdpStatus } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateTenantIdentityProviderProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantIdentityProviderEntity['tenantId'];
  protocol: ITenantIdentityProviderEntity['protocol'];
  displayName: ITenantIdentityProviderEntity['displayName'];
  config: ITenantIdentityProviderEntity['config'];
  providerStatus?: ITenantIdentityProviderEntity['providerStatus'];
  encryptedSecretRef?: ITenantIdentityProviderEntity['encryptedSecretRef'];
  directoryCredentialsRef?: ITenantIdentityProviderEntity['directoryCredentialsRef'];

  createdAt?: ITenantIdentityProviderEntity['createdAt'];
  updatedAt?: ITenantIdentityProviderEntity['updatedAt'];
  createdBy?: ITenantIdentityProviderEntity['createdBy'];
  updatedBy?: ITenantIdentityProviderEntity['updatedBy'];
}

export class TenantIdentityProviderFactory {
  static CreateTenantIdentityProvider(props: CreateTenantIdentityProviderProps): TenantIdentityProviderEntity {
    const id = generateId();
    const now = new Date();

    return new TenantIdentityProviderEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      protocol: props.protocol,
      displayName: props.displayName,
      config: props.config,
      // DRAFT until a successful "Test connection" (D7 — prevents self-lockout).
      providerStatus: props.providerStatus ?? IdpStatus.DRAFT,
      encryptedSecretRef: props.encryptedSecretRef ?? null,
      directoryCredentialsRef: props.directoryCredentialsRef ?? null,
    });
  }
}
