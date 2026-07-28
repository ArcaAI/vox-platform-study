/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Optional per-(tenant, provider) bring-your-own credential. The plaintext API
// key is NEVER held here; only the Vault-Transit ciphertext (`encryptedApiKey`)
// + `keyVersion` are persisted. `provider` ∈ azure-speech | sarvam | openai.
// `endpoint` (Azure Foundry resource / OpenAI-compatible base URL) and `region`
// (classic Azure Speech) are non-secret config; `extraJson` carries per-provider
// extras (foundryModel / model / languageCode).
export interface ITenantSttProviderCredentialEntity extends IBaseTenantEntity {
  provider: string;
  endpoint?: string | null;
  region?: string | null;
  encryptedApiKey?: Uint8Array | null;
  keyVersion?: number | null;
  enabled: boolean;
  extraJson?: Record<string, unknown> | null;
}

export class TenantSttProviderCredentialEntity extends BaseTenantEntity {
  private _provider: ITenantSttProviderCredentialEntity['provider'];
  private _endpoint?: ITenantSttProviderCredentialEntity['endpoint'];
  private _region?: ITenantSttProviderCredentialEntity['region'];
  private _encryptedApiKey?: ITenantSttProviderCredentialEntity['encryptedApiKey'];
  private _keyVersion?: ITenantSttProviderCredentialEntity['keyVersion'];
  private _enabled: ITenantSttProviderCredentialEntity['enabled'];
  private _extraJson?: ITenantSttProviderCredentialEntity['extraJson'];

  constructor(init: ITenantSttProviderCredentialEntity) {
    super(init);
    this._provider = init.provider;
    this._endpoint = init.endpoint;
    this._region = init.region;
    this._encryptedApiKey = init.encryptedApiKey;
    this._keyVersion = init.keyVersion;
    this._enabled = init.enabled;
    this._extraJson = init.extraJson;
  }

  get provider(): ITenantSttProviderCredentialEntity['provider'] {
    return this._provider;
  }

  set provider(value: ITenantSttProviderCredentialEntity['provider']) {
    this.setProperty('provider', value);
  }

  get endpoint(): ITenantSttProviderCredentialEntity['endpoint'] {
    return this._endpoint;
  }

  set endpoint(value: ITenantSttProviderCredentialEntity['endpoint']) {
    this.setProperty('endpoint', value);
  }

  get region(): ITenantSttProviderCredentialEntity['region'] {
    return this._region;
  }

  set region(value: ITenantSttProviderCredentialEntity['region']) {
    this.setProperty('region', value);
  }

  get encryptedApiKey(): ITenantSttProviderCredentialEntity['encryptedApiKey'] {
    return this._encryptedApiKey;
  }

  set encryptedApiKey(value: ITenantSttProviderCredentialEntity['encryptedApiKey']) {
    this.setProperty('encryptedApiKey', value);
  }

  get keyVersion(): ITenantSttProviderCredentialEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: ITenantSttProviderCredentialEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get enabled(): ITenantSttProviderCredentialEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: ITenantSttProviderCredentialEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  get extraJson(): ITenantSttProviderCredentialEntity['extraJson'] {
    return this._extraJson;
  }

  set extraJson(value: ITenantSttProviderCredentialEntity['extraJson']) {
    this.setProperty('extraJson', value);
  }

  public override validate(): void {
    if (!this._provider) {
      throw new BusinessException('STT provider credential requires a provider');
    }
  }
}
