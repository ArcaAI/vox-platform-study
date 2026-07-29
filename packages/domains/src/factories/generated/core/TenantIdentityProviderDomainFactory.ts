/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantIdentityProviderDomainEntity, TenantIdentityProviderDomainEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantIdentityProviderDomainProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantIdentityProviderDomainEntity['tenantId'];
  providerId: ITenantIdentityProviderDomainEntity['providerId'];
  domain: ITenantIdentityProviderDomainEntity['domain'];

  createdAt?: ITenantIdentityProviderDomainEntity['createdAt'];
  updatedAt?: ITenantIdentityProviderDomainEntity['updatedAt'];
  createdBy?: ITenantIdentityProviderDomainEntity['createdBy'];
  updatedBy?: ITenantIdentityProviderDomainEntity['updatedBy'];
}

export class TenantIdentityProviderDomainFactory {
  static CreateTenantIdentityProviderDomain(props: CreateTenantIdentityProviderDomainProps): TenantIdentityProviderDomainEntity {
    const id = generateId();
    const now = new Date();

    return new TenantIdentityProviderDomainEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      providerId: props.providerId,
      domain: props.domain,
    });
  }
}
