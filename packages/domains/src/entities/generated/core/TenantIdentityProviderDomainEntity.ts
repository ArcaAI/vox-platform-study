/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-498 — verified email-domain → provider allowlist for home-realm
// discovery (HRD) at login. `domain` is globally unique at the schema level
// (one domain routes to exactly one provider). DNS-TXT domain verification is
// deferred/optional in v1.
export interface ITenantIdentityProviderDomainEntity extends IBaseTenantEntity {
  providerId: string;
  domain: string;
}

export class TenantIdentityProviderDomainEntity extends BaseTenantEntity {
  private _providerId: ITenantIdentityProviderDomainEntity['providerId'];
  private _domain: ITenantIdentityProviderDomainEntity['domain'];

  constructor(init: ITenantIdentityProviderDomainEntity) {
    super(init);
    this._providerId = init.providerId;
    this._domain = init.domain;
  }

  get providerId(): ITenantIdentityProviderDomainEntity['providerId'] {
    return this._providerId;
  }

  set providerId(value: ITenantIdentityProviderDomainEntity['providerId']) {
    this.setProperty('providerId', value);
  }

  get domain(): ITenantIdentityProviderDomainEntity['domain'] {
    return this._domain;
  }

  set domain(value: ITenantIdentityProviderDomainEntity['domain']) {
    this.setProperty('domain', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._domain || !this._domain.trim()) {
      throw new BusinessException('TenantIdentityProviderDomain domain is required');
    }
    if (!this._providerId || !this._providerId.trim()) {
      throw new BusinessException('TenantIdentityProviderDomain providerId is required');
    }
  }
}
