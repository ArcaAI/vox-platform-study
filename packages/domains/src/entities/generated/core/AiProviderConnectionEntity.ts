/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// WHERE a serving provider lives and HOW to authenticate: one row
// per (tenant, SERVICE, provider); the reserved SYSTEM tenant row is the
// platform default. The UNIFIED provider-connection plane for all three AI
// capabilities (llm | stt | tts) — unifies the former
// TenantTtsProviderCredential / TenantSttProviderCredential tables (TASK-569).
//
// `encryptedApiKey` is Vault-Transit ciphertext produced by
// `encryptSecretField` — the entity NEVER sees plaintext and no read DTO ever
// carries the bytes (`hasKey: boolean` only).
//
// The `service` discriminator resolves the provider-name collision across
// capabilities (`azure` = Azure OpenAI under llm, Azure Speech under stt). The
// per-service cloud-only tenant-row rule and the resolution cascade
// (tenant row → SYSTEM row → service env, filtered by service) live in the
// application service (`ProviderConnectionService`); this entity carries only
// structural invariants.
export interface IAiProviderConnectionEntity extends IBaseTenantEntity {
  service: string;
  provider: string;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  encryptedApiKey?: Uint8Array | null;
  keyVersion?: number | null;
  enabled: boolean;
  extraJson?: Record<string, unknown> | null;
}

export class AiProviderConnectionEntity extends BaseTenantEntity {
  private _service: IAiProviderConnectionEntity['service'];
  private _provider: IAiProviderConnectionEntity['provider'];
  private _baseUrl?: IAiProviderConnectionEntity['baseUrl'];
  private _region?: IAiProviderConnectionEntity['region'];
  private _apiVersion?: IAiProviderConnectionEntity['apiVersion'];
  private _deploymentName?: IAiProviderConnectionEntity['deploymentName'];
  private _encryptedApiKey?: IAiProviderConnectionEntity['encryptedApiKey'];
  private _keyVersion?: IAiProviderConnectionEntity['keyVersion'];
  private _enabled: IAiProviderConnectionEntity['enabled'];
  private _extraJson?: IAiProviderConnectionEntity['extraJson'];

  constructor(init: IAiProviderConnectionEntity) {
    super(init);
    this._service = init.service;
    this._provider = init.provider;
    this._baseUrl = init.baseUrl;
    this._region = init.region;
    this._apiVersion = init.apiVersion;
    this._deploymentName = init.deploymentName;
    this._encryptedApiKey = init.encryptedApiKey;
    this._keyVersion = init.keyVersion;
    this._enabled = init.enabled;
    this._extraJson = init.extraJson;
  }

  get service(): IAiProviderConnectionEntity['service'] {
    return this._service;
  }

  set service(value: IAiProviderConnectionEntity['service']) {
    this.setProperty('service', value);
  }

  get provider(): IAiProviderConnectionEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiProviderConnectionEntity['provider']) {
    this.setProperty('provider', value);
  }

  get baseUrl(): IAiProviderConnectionEntity['baseUrl'] {
    return this._baseUrl;
  }

  set baseUrl(value: IAiProviderConnectionEntity['baseUrl']) {
    this.setProperty('baseUrl', value);
  }

  get region(): IAiProviderConnectionEntity['region'] {
    return this._region;
  }

  set region(value: IAiProviderConnectionEntity['region']) {
    this.setProperty('region', value);
  }

  get apiVersion(): IAiProviderConnectionEntity['apiVersion'] {
    return this._apiVersion;
  }

  set apiVersion(value: IAiProviderConnectionEntity['apiVersion']) {
    this.setProperty('apiVersion', value);
  }

  get deploymentName(): IAiProviderConnectionEntity['deploymentName'] {
    return this._deploymentName;
  }

  set deploymentName(value: IAiProviderConnectionEntity['deploymentName']) {
    this.setProperty('deploymentName', value);
  }

  get encryptedApiKey(): IAiProviderConnectionEntity['encryptedApiKey'] {
    return this._encryptedApiKey;
  }

  set encryptedApiKey(value: IAiProviderConnectionEntity['encryptedApiKey']) {
    this.setProperty('encryptedApiKey', value);
  }

  get keyVersion(): IAiProviderConnectionEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IAiProviderConnectionEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get enabled(): IAiProviderConnectionEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: IAiProviderConnectionEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  get extraJson(): IAiProviderConnectionEntity['extraJson'] {
    return this._extraJson;
  }

  set extraJson(value: IAiProviderConnectionEntity['extraJson']) {
    this.setProperty('extraJson', value);
  }

  /** True when key material is present, without exposing it. Read DTOs use this. */
  get hasKey(): boolean {
    return this._encryptedApiKey != null && this._encryptedApiKey.length > 0;
  }

  public override validate(): void {
    super.validate();
    if (!this._service || this._service.trim().length === 0) {
      throw new BusinessException('Service is required');
    }
    if (!this._provider || this._provider.trim().length === 0) {
      throw new BusinessException('Provider is required');
    }
    // Ciphertext and its key version travel together — a half-written secret
    // would silently fail to decrypt at the gateway.
    if (this.hasKey && (this._keyVersion == null || this._keyVersion < 1)) {
      throw new BusinessException('Key version is required when an encrypted API key is present');
    }
  }
}
