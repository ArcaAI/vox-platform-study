/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// WHERE a serving provider lives and HOW to authenticate. TASK-958: one
// DEFAULT row per (tenant, SERVICE, provider) plus any number of NAMED sibling
// rows on the tenant tier; identity is `(tenantId, service, slug)` and
// `defaultForProvider` marks the one row the provider-NAME cascade sees. The
// SYSTEM tier stays one row per provider and its row is the platform default. The UNIFIED provider-connection plane for all three AI
// capabilities (llm | stt | tts) — unifies the former
// TenantTtsProviderCredential / TenantSttProviderCredential tables.
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
  /**
   * TASK-958 — connection identity within `(tenantId, service)`. Tenant-chosen,
   * `^[a-z0-9][a-z0-9-]{1,62}$`, IMMUTABLE after create: it is embedded in BYO
   * model slugs and in the `connection_key` on the Python wire, so renaming it
   * would re-key live bindings. Every pre-TASK-958 row was backfilled to
   * `provider`, which is why nothing addressed by provider name broke.
   */
  slug: string;
  /** Display label ("Research account"). `null` = fall back to the slug. */
  name?: string | null;
  /**
   * `provider` on the tenant's DEFAULT connection for that provider, `null` on
   * every sibling. Backed by `@@unique([tenantId, service, defaultForProvider])`,
   * so "at most one default per provider" is a DATABASE fact, not a convention.
   */
  defaultForProvider?: string | null;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  encryptedApiKey?: Uint8Array | null;
  keyVersion?: number | null;
  enabled: boolean;
  extraJson?: Record<string, unknown> | null;
  /** TASK-862 — connection-level ceilings (moved from the retired `AiRuntimeProfile`). Null = no opinion. */
  maxConcurrent?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  timeoutS?: number | null;
}

export class AiProviderConnectionEntity extends BaseTenantEntity {
  /** `^[a-z0-9][a-z0-9-]{1,62}$` — 2-63 chars, DNS-label-ish, no trailing rule. */
  public static readonly SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

  private _service: IAiProviderConnectionEntity['service'];
  private _provider: IAiProviderConnectionEntity['provider'];
  private _slug: IAiProviderConnectionEntity['slug'];
  private _name?: IAiProviderConnectionEntity['name'];
  private _defaultForProvider?: IAiProviderConnectionEntity['defaultForProvider'];
  private _baseUrl?: IAiProviderConnectionEntity['baseUrl'];
  private _region?: IAiProviderConnectionEntity['region'];
  private _apiVersion?: IAiProviderConnectionEntity['apiVersion'];
  private _deploymentName?: IAiProviderConnectionEntity['deploymentName'];
  private _encryptedApiKey?: IAiProviderConnectionEntity['encryptedApiKey'];
  private _keyVersion?: IAiProviderConnectionEntity['keyVersion'];
  private _enabled: IAiProviderConnectionEntity['enabled'];
  private _extraJson?: IAiProviderConnectionEntity['extraJson'];
  private _maxConcurrent?: IAiProviderConnectionEntity['maxConcurrent'];
  private _rpmLimit?: IAiProviderConnectionEntity['rpmLimit'];
  private _tpmLimit?: IAiProviderConnectionEntity['tpmLimit'];
  private _timeoutS?: IAiProviderConnectionEntity['timeoutS'];

  constructor(init: IAiProviderConnectionEntity) {
    super(init);
    this._service = init.service;
    this._provider = init.provider;
    this._slug = init.slug;
    this._name = init.name;
    this._defaultForProvider = init.defaultForProvider;
    this._baseUrl = init.baseUrl;
    this._region = init.region;
    this._apiVersion = init.apiVersion;
    this._deploymentName = init.deploymentName;
    this._encryptedApiKey = init.encryptedApiKey;
    this._keyVersion = init.keyVersion;
    this._enabled = init.enabled;
    this._extraJson = init.extraJson;
    this._maxConcurrent = init.maxConcurrent;
    this._rpmLimit = init.rpmLimit;
    this._tpmLimit = init.tpmLimit;
    this._timeoutS = init.timeoutS;
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

  get slug(): IAiProviderConnectionEntity['slug'] {
    return this._slug;
  }

  /**
   * Immutability is an APPLICATION-layer rule (`ProviderConnectionService`
   * refuses a slug change), not a structural one — the setter exists so the
   * create path and the change-tracking machinery behave like every other
   * property.
   */
  set slug(value: IAiProviderConnectionEntity['slug']) {
    this.setProperty('slug', value);
  }

  get name(): IAiProviderConnectionEntity['name'] {
    return this._name;
  }

  set name(value: IAiProviderConnectionEntity['name']) {
    this.setProperty('name', value);
  }

  get defaultForProvider(): IAiProviderConnectionEntity['defaultForProvider'] {
    return this._defaultForProvider;
  }

  set defaultForProvider(value: IAiProviderConnectionEntity['defaultForProvider']) {
    this.setProperty('defaultForProvider', value);
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

  get maxConcurrent(): IAiProviderConnectionEntity['maxConcurrent'] {
    return this._maxConcurrent;
  }

  set maxConcurrent(value: IAiProviderConnectionEntity['maxConcurrent']) {
    this.setProperty('maxConcurrent', value);
  }

  get rpmLimit(): IAiProviderConnectionEntity['rpmLimit'] {
    return this._rpmLimit;
  }

  set rpmLimit(value: IAiProviderConnectionEntity['rpmLimit']) {
    this.setProperty('rpmLimit', value);
  }

  get tpmLimit(): IAiProviderConnectionEntity['tpmLimit'] {
    return this._tpmLimit;
  }

  set tpmLimit(value: IAiProviderConnectionEntity['tpmLimit']) {
    this.setProperty('tpmLimit', value);
  }

  get timeoutS(): IAiProviderConnectionEntity['timeoutS'] {
    return this._timeoutS;
  }

  set timeoutS(value: IAiProviderConnectionEntity['timeoutS']) {
    this.setProperty('timeoutS', value);
  }

  /**
   * TASK-958 — is this the row the provider-NAME cascade resolves to?
   *
   * DERIVED, never stored: `defaultForProvider` is the column, and it carries
   * the provider id rather than a boolean precisely so the unique index can
   * enforce one default per provider. Reading it as a boolean is what every
   * caller actually wants.
   */
  get isDefault(): boolean {
    return this._defaultForProvider != null && this._defaultForProvider === this._provider;
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
    // TASK-958 — the slug is a URL path segment, a BYO model-slug prefix and a
    // wire key, so its shape is a STRUCTURAL invariant, not a DTO nicety: a row
    // that reached persistence with a bad slug would mint unroutable model
    // slugs and an unaddressable route.
    if (!AiProviderConnectionEntity.SLUG_PATTERN.test(this._slug ?? '')) {
      throw new BusinessException(
        'Slug must be 2-63 characters of lowercase letters, digits and hyphens, starting with a letter or digit',
      );
    }
    // `defaultForProvider` is the provider id or nothing. Any other value would
    // put the row in a default slot that belongs to a provider it cannot serve.
    if (this._defaultForProvider != null && this._defaultForProvider !== this._provider) {
      throw new BusinessException('defaultForProvider must equal provider, or be null on a non-default connection');
    }
    // Ciphertext and its key version travel together — a half-written secret
    // would silently fail to decrypt at the gateway.
    if (this.hasKey && (this._keyVersion == null || this._keyVersion < 1)) {
      throw new BusinessException('Key version is required when an encrypted API key is present');
    }
    // A ceiling is a positive cap or no opinion — zero would silently refuse
    // every request on the connection, which is what `enabled: false` is for.
    for (const [name, value] of [
      ['maxConcurrent', this._maxConcurrent],
      ['rpmLimit', this._rpmLimit],
      ['tpmLimit', this._tpmLimit],
      ['timeoutS', this._timeoutS],
    ] as const) {
      if (value != null && (!Number.isInteger(value) || value < 1)) {
        throw new BusinessException(`${name} must be a positive integer when set`);
      }
    }
  }
}
