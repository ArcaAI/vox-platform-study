/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

// TASK-498 — a tenant admin's configured external IdP (OIDC v1; `protocol`
// ships both OIDC and SAML values so the model is protocol-neutral, but v1
// service-layer validation accepts OIDC only — TASK-499 extends this row for
// SAML). Non-secret config lives in `config`; `encryptedSecretRef` /
// `directoryCredentialsRef` are Vault Transit ciphertext refs — plaintext is
// never stored here.
export interface ITenantIdentityProviderEntity extends IBaseTenantEntity {
  protocol: Enums.IdpProtocol;
  displayName: string;
  providerStatus: Enums.IdpStatus;
  config: Record<string, unknown>;
  encryptedSecretRef?: string | null;
  directoryCredentialsRef?: string | null;
}

export class TenantIdentityProviderEntity extends BaseTenantEntity {
  private _protocol: ITenantIdentityProviderEntity['protocol'];
  private _displayName: ITenantIdentityProviderEntity['displayName'];
  private _providerStatus: ITenantIdentityProviderEntity['providerStatus'];
  private _config: ITenantIdentityProviderEntity['config'];
  private _encryptedSecretRef?: ITenantIdentityProviderEntity['encryptedSecretRef'];
  private _directoryCredentialsRef?: ITenantIdentityProviderEntity['directoryCredentialsRef'];

  constructor(init: ITenantIdentityProviderEntity) {
    super(init);
    this._protocol = init.protocol;
    this._displayName = init.displayName;
    this._providerStatus = init.providerStatus;
    this._config = init.config;
    this._encryptedSecretRef = init.encryptedSecretRef;
    this._directoryCredentialsRef = init.directoryCredentialsRef;
  }

  get protocol(): ITenantIdentityProviderEntity['protocol'] {
    return this._protocol;
  }

  set protocol(value: ITenantIdentityProviderEntity['protocol']) {
    this.setProperty('protocol', value);
  }

  get displayName(): ITenantIdentityProviderEntity['displayName'] {
    return this._displayName;
  }

  set displayName(value: ITenantIdentityProviderEntity['displayName']) {
    this.setProperty('displayName', value);
  }

  get providerStatus(): ITenantIdentityProviderEntity['providerStatus'] {
    return this._providerStatus;
  }

  set providerStatus(value: ITenantIdentityProviderEntity['providerStatus']) {
    this.setProperty('providerStatus', value);
  }

  get config(): ITenantIdentityProviderEntity['config'] {
    return this._config;
  }

  set config(value: ITenantIdentityProviderEntity['config']) {
    this.setProperty('config', value);
  }

  get encryptedSecretRef(): ITenantIdentityProviderEntity['encryptedSecretRef'] {
    return this._encryptedSecretRef;
  }

  set encryptedSecretRef(value: ITenantIdentityProviderEntity['encryptedSecretRef']) {
    this.setProperty('encryptedSecretRef', value);
  }

  get directoryCredentialsRef(): ITenantIdentityProviderEntity['directoryCredentialsRef'] {
    return this._directoryCredentialsRef;
  }

  set directoryCredentialsRef(value: ITenantIdentityProviderEntity['directoryCredentialsRef']) {
    this.setProperty('directoryCredentialsRef', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._displayName || !this._displayName.trim()) {
      throw new BusinessException('TenantIdentityProvider displayName is required');
    }
    if (!this._protocol) {
      throw new BusinessException('TenantIdentityProvider protocol is required');
    }
    if (!this._config) {
      throw new BusinessException('TenantIdentityProvider config is required');
    }
  }
}
