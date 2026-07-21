/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Optional per-(tenant, provider) bring-your-own credential. The
// plaintext API key is NEVER held here; only the Vault-Transit ciphertext
// (`encryptedApiKey`) + `keyVersion` are persisted.
export interface ITenantTtsProviderCredentialEntity extends IBaseTenantEntity {
  provider: string;
  endpoint?: string | null;
  encryptedApiKey?: Uint8Array | null;
  keyVersion?: number | null;
  enabled: boolean;
}

export class TenantTtsProviderCredentialEntity extends BaseTenantEntity {
  private _provider: ITenantTtsProviderCredentialEntity['provider'];
  private _endpoint?: ITenantTtsProviderCredentialEntity['endpoint'];
  private _encryptedApiKey?: ITenantTtsProviderCredentialEntity['encryptedApiKey'];
  private _keyVersion?: ITenantTtsProviderCredentialEntity['keyVersion'];
  private _enabled: ITenantTtsProviderCredentialEntity['enabled'];

  constructor(init: ITenantTtsProviderCredentialEntity) {
    super(init);
    this._provider = init.provider;
    this._endpoint = init.endpoint;
    this._encryptedApiKey = init.encryptedApiKey;
    this._keyVersion = init.keyVersion;
    this._enabled = init.enabled;
  }

  get provider(): ITenantTtsProviderCredentialEntity['provider'] {
    return this._provider;
  }

  set provider(value: ITenantTtsProviderCredentialEntity['provider']) {
    this.setProperty('provider', value);
  }

  get endpoint(): ITenantTtsProviderCredentialEntity['endpoint'] {
    return this._endpoint;
  }

  set endpoint(value: ITenantTtsProviderCredentialEntity['endpoint']) {
    this.setProperty('endpoint', value);
  }

  get encryptedApiKey(): ITenantTtsProviderCredentialEntity['encryptedApiKey'] {
    return this._encryptedApiKey;
  }

  set encryptedApiKey(value: ITenantTtsProviderCredentialEntity['encryptedApiKey']) {
    this.setProperty('encryptedApiKey', value);
  }

  get keyVersion(): ITenantTtsProviderCredentialEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: ITenantTtsProviderCredentialEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get enabled(): ITenantTtsProviderCredentialEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: ITenantTtsProviderCredentialEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  public override validate(): void {
    if (!this._provider) {
      throw new BusinessException('TTS provider credential requires a provider');
    }
  }
}
