import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelEntity,
  AiModelRepository,
  ModelTaskType,
  ResourceType,
  SysEventType,
  SYSTEM_TENANT_ID,
  TenantTtsConfigEntity,
  TenantTtsConfigFactory,
  TenantTtsConfigRepository,
  TenantTtsProviderCredentialEntity,
  TenantTtsProviderCredentialFactory,
  TenantTtsProviderCredentialRepository,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { decryptSecretField, encryptSecretField, SecretsService } from '../baseServices/_meta/secrets';
import { ITenantTtsConfigService } from './ITenantTtsConfigService';
import { TenantTtsConfigDtoMapper } from './tenant-tts-config.dto.mapper';
import {
  EffectiveTtsConfigResponse,
  SetTtsCredentialRequest,
  TenantTtsConfigResponse,
  TtsCatalogProvider,
  TtsCatalogVoice,
  TtsCredentialResponse,
  TtsPlatformCatalogResponse,
  UpdateTenantTtsConfigRequest,
} from './dto';
import {
  BYO_PROVIDERS,
  mergeVoiceBindings,
  PLATFORM_TTS_LIMITS,
  resolveEffectiveTtsConfig,
  TtsProviderOverrides,
  TtsSpecInput,
  TtsVoiceBindings,
} from './platform-limits';

/** Editable spec fields (everything on the update DTO except the OCC token). */
const SPEC_FIELDS = [
  'defaultVoiceEn',
  'defaultVoiceMl',
  'routingEn',
  'routingMl',
  'allowedProviders',
  'defaultFormat',
  'defaultSpeed',
  'sampleRate',
  'maxInputChars',
  'sarvamPublicApiAllowed',
] as const;

@Injectable()
export class TenantTtsConfigService extends BaseService implements ITenantTtsConfigService {
  constructor(
    private readonly configRepository: TenantTtsConfigRepository,
    private readonly credentialRepository: TenantTtsProviderCredentialRepository,
    // SYSTEM TTS registry rows drive the platform catalog +
    // provider-universe / voice-binding validation (code-constant fallback).
    private readonly aiModelRepository: AiModelRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // BYO-key encryption (D1). Optional so non-Vault deploys still run the curated
    // spec; credential writes then reject (no plaintext-at-rest fallback).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantTtsConfig);
  }

  async getRow(tenantId: string): Promise<TenantTtsConfigResponse> {
    const row = await this.configRepository.findByTenantId(tenantId);
    return row ? TenantTtsConfigDtoMapper.toResponse(row) : TenantTtsConfigDtoMapper.placeholder(tenantId);
  }

  async getEffective(tenantId: string): Promise<EffectiveTtsConfigResponse> {
    const [systemRow, tenantRow, registryProviders] = await Promise.all([
      this.configRepository.findByTenantId(SYSTEM_TENANT_ID),
      this.configRepository.findByTenantId(tenantId),
      this.loadRegistryCatalogCached(),
    ]);
    // Registry-driven provider universe: a
    // provider whose SYSTEM registry row is disabled/absent is stripped from
    // the effective whitelist + routing chains platform-wide. Empty catalog
    // (pre-seed) → the resolver's code-constant universe, exactly the rule
    // `upsertRow`'s validation uses.
    const universe = registryProviders.length > 0 ? new Set(registryProviders.map((p) => p.provider)) : undefined;
    const effective = resolveEffectiveTtsConfig(this.toSpec(systemRow), this.toSpec(tenantRow), universe);
    // SYSTEM bindings merged under tenant bindings (per-voice-id
    // shallow merge, tenant wins per provider entry).
    const voiceBindings = mergeVoiceBindings(this.bindingsOf(systemRow), this.bindingsOf(tenantRow));
    return { tenantId, ...effective, voiceBindings };
  }

  /**
   * The platform TTS catalog: SYSTEM-tenant ENABLED
   * `TEXT_TO_SPEECH` registry rows mapped to routing providers with their
   * `metaData.voices`. Falls back to the code-constant provider universe
   * (no voice metadata) when the registry has no TTS rows yet, so nothing
   * breaks pre-seed.
   */
  async getPlatformCatalog(): Promise<TtsPlatformCatalogResponse> {
    const providers = await this.loadRegistryCatalog();
    if (providers.length > 0) {
      return { providers };
    }
    return {
      providers: PLATFORM_TTS_LIMITS.providerUniverse.map<TtsCatalogProvider>((provider) => ({
        provider,
        slug: provider,
        name: provider,
        voices: [],
      })),
    };
  }

  async upsertRow(tenantId: string, dto: UpdateTenantTtsConfigRequest): Promise<TenantTtsConfigResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Validate provider entries + voice bindings against the
    // registry-derived catalog (code-constant universe pre-seed).
    const registryProviders = await this.loadRegistryCatalog();
    const universe: ReadonlySet<string> =
      registryProviders.length > 0 ? new Set(registryProviders.map((p) => p.provider)) : new Set<string>(PLATFORM_TTS_LIMITS.providerUniverse);
    this.assertProvidersInUniverse(dto, universe);
    if (dto.voiceBindings !== undefined) {
      this.assertValidVoiceBindings(dto.voiceBindings, universe, registryProviders);
    }

    const existing = await this.configRepository.findByTenantId(tenantId);

    if (!existing) {
      // No row yet — a create. The client must declare `expectedVersion: 0`.
      if (dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('TenantTtsConfig', tenantId, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = TenantTtsConfigFactory.CreateTenantTtsConfig({
        tenantId,
        ...this.pickSpec(dto),
        ...(dto.voiceBindings !== undefined ? { configJson: { voiceBindings: dto.voiceBindings } } : {}),
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.configRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
      });
      return TenantTtsConfigDtoMapper.toResponse(saved);
    }

    const changes: Record<string, unknown> = this.pickSpec(dto);
    if (dto.voiceBindings !== undefined) {
      // Bindings live under configJson; other configJson keys are preserved.
      changes.configJson = { ...(existing.configJson ?? {}), voiceBindings: dto.voiceBindings };
    }
    await this.updateEntity(existing, changes);
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }
    const previousVersion = existing.version;
    const updated = await this.configRepository.updateWithVersion(existing.id, existing, dto.expectedVersion);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { previousVersion, newVersion: updated.version },
    });
    return TenantTtsConfigDtoMapper.toResponse(updated);
  }

  /** Entity → nullable spec shape for the resolver. */
  private toSpec(entity: TenantTtsConfigEntity | null): TtsSpecInput | null {
    if (!entity) return null;
    return {
      routingEn: entity.routingEn,
      routingMl: entity.routingMl,
      allowedProviders: entity.allowedProviders,
      defaultVoiceEn: entity.defaultVoiceEn ?? null,
      defaultVoiceMl: entity.defaultVoiceMl ?? null,
      defaultFormat: entity.defaultFormat ?? null,
      defaultSpeed: entity.defaultSpeed ?? null,
      sampleRate: entity.sampleRate ?? null,
      maxInputChars: entity.maxInputChars ?? null,
      sarvamPublicApiAllowed: entity.sarvamPublicApiAllowed,
    };
  }

  /** Only the spec fields the caller actually supplied (drops the OCC token + undefined). */
  private pickSpec(dto: UpdateTenantTtsConfigRequest): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of SPEC_FIELDS) {
      const value = (dto as unknown as Record<string, unknown>)[field];
      if (value !== undefined) {
        out[field] = value;
      }
    }
    return out;
  }

  // ───────────────── registry-derived catalog helpers ─────────────────

  /**
   * `getEffective` sits on the speech-proxy/WS hot path, so
   * its catalog read is memoized for a short TTL (admin edits to the registry
   * surface within ~30s; the admin surfaces keep reading fresh via
   * `loadRegistryCatalog`).
   */
  private static readonly CATALOG_CACHE_TTL_MS = 30_000;
  private catalogCache: { at: number; providers: TtsCatalogProvider[] } | null = null;

  private async loadRegistryCatalogCached(): Promise<TtsCatalogProvider[]> {
    const now = Date.now();
    if (this.catalogCache && now - this.catalogCache.at < TenantTtsConfigService.CATALOG_CACHE_TTL_MS) {
      return this.catalogCache.providers;
    }
    const providers = await this.loadRegistryCatalog();
    this.catalogCache = { at: now, providers };
    return providers;
  }

  /** SYSTEM ENABLED TEXT_TO_SPEECH registry rows → catalog providers (may be empty pre-seed). */
  private async loadRegistryCatalog(): Promise<TtsCatalogProvider[]> {
    const rows = await this.aiModelRepository.findByTaskType(SYSTEM_TENANT_ID, ModelTaskType.TEXT_TO_SPEECH);
    return rows.map((row) => ({
      provider: this.catalogProviderId(row),
      slug: row.slug,
      name: row.name,
      voices: this.catalogVoices(row),
    }));
  }

  /**
   * TTS routing provider id for a registry row. Contract with the model
   * seed: cloud engines carry it on the `provider` column (`azure`, `sarvam`);
   * `built-in` engines declare it as `metaData.ttsProvider` (`kokoro`,
   * `indic_parler`, `indic_f5`); slug-underscored is the last resort.
   */
  private catalogProviderId(row: AiModelEntity): string {
    const metaProvider = row.metaData?.ttsProvider;
    if (typeof metaProvider === 'string' && metaProvider.length > 0) {
      return metaProvider;
    }
    if (row.provider && row.provider !== 'built-in') {
      return row.provider;
    }
    return row.slug.replace(/-/g, '_');
  }

  /** `metaData.voices` normalized to the catalog voice shape (invalid entries dropped). */
  private catalogVoices(row: AiModelEntity): TtsCatalogVoice[] {
    const voices = row.metaData?.voices;
    if (!Array.isArray(voices)) {
      return [];
    }
    const out: TtsCatalogVoice[] = [];
    for (const voice of voices) {
      if (!voice || typeof voice !== 'object' || typeof voice.id !== 'string') {
        continue;
      }
      out.push({
        id: voice.id,
        locale: typeof voice.locale === 'string' ? voice.locale : '',
        ...(typeof voice.gender === 'string' ? { gender: voice.gender } : {}),
        ...(typeof voice.name === 'string' ? { name: voice.name } : {}),
      });
    }
    return out;
  }

  /** Reject routing/whitelist entries outside the (catalog-derived) provider universe. */
  private assertProvidersInUniverse(dto: UpdateTenantTtsConfigRequest, universe: ReadonlySet<string>): void {
    for (const field of ['routingEn', 'routingMl', 'allowedProviders'] as const) {
      const chain = dto[field];
      if (!chain) {
        continue;
      }
      for (const provider of chain) {
        if (!universe.has(provider)) {
          throw new ArgumentInvalidException(`Unknown TTS provider '${provider}' in ${field}. Platform providers: ${[...universe].join(', ')}`);
        }
      }
    }
  }

  /**
   * Validate `voiceBindings` structure + targets: providers must be in the
   * universe; when the registry catalog declares a provider's voices, the
   * bound voice must be one of them (matched by voice `id` or `name`); with
   * an empty catalog (pre-seed) the name check is skipped.
   */
  private assertValidVoiceBindings(bindings: TtsVoiceBindings, universe: ReadonlySet<string>, registryProviders: TtsCatalogProvider[]): void {
    const byProvider = new Map(registryProviders.map((p) => [p.provider, p]));
    for (const [voiceId, providerMap] of Object.entries(bindings)) {
      if (!providerMap || typeof providerMap !== 'object' || Array.isArray(providerMap)) {
        throw new ArgumentInvalidException(`voiceBindings['${voiceId}'] must be a { provider: voiceName } map.`);
      }
      for (const [provider, voiceName] of Object.entries(providerMap)) {
        if (typeof voiceName !== 'string' || voiceName.length === 0) {
          throw new ArgumentInvalidException(`voiceBindings['${voiceId}'].${provider} must be a non-empty voice name.`);
        }
        if (!universe.has(provider)) {
          throw new ArgumentInvalidException(
            `voiceBindings['${voiceId}'] targets unknown TTS provider '${provider}'. Platform providers: ${[...universe].join(', ')}`,
          );
        }
        const catalogEntry = byProvider.get(provider);
        if (catalogEntry && catalogEntry.voices.length > 0) {
          const known = catalogEntry.voices.some((v) => v.id === voiceName || v.name === voiceName);
          if (!known) {
            throw new ArgumentInvalidException(
              `Voice '${voiceName}' is not offered by provider '${provider}' (catalog: ${catalogEntry.voices.map((v) => v.id).join(', ')}).`,
            );
          }
        }
      }
    }
  }

  /** The row's persisted voiceBindings (empty map when absent/malformed). */
  private bindingsOf(entity: TenantTtsConfigEntity | null): TtsVoiceBindings {
    const raw = entity?.configJson?.['voiceBindings'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as TtsVoiceBindings;
    }
    return {};
  }

  // ─────────────────────── BYO credentials ───────────────────────

  /** Masked list of a tenant's BYO credentials (never the key). */
  async getCredentials(tenantId: string): Promise<TtsCredentialResponse[]> {
    const rows = await this.credentialRepository.findByTenantId(tenantId);
    return rows.map((row) => this.maskCredential(row));
  }

  /** Set or rotate a tenant's BYO key for a provider (encrypted at rest). */
  async setCredential(tenantId: string, provider: string, dto: SetTtsCredentialRequest): Promise<TtsCredentialResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    if (!(BYO_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unsupported BYO provider '${provider}'. Expected: ${BYO_PROVIDERS.join(', ')}`);
    }
    if (!this.secretsService) {
      throw new BadRequestException('BYO provider keys require the Vault secrets provider (SECRETS_PROVIDER=vault).');
    }

    const { ciphertext: encryptedApiKey, keyVersion } = await encryptSecretField(this.secretsService, dto.apiKey);
    const endpoint = dto.endpoint ?? null;
    const enabled = dto.enabled ?? true;

    const existing = await this.credentialRepository.findByTenantAndProvider(tenantId, provider);
    if (!existing) {
      const entity = TenantTtsProviderCredentialFactory.CreateTenantTtsProviderCredential({
        tenantId,
        provider,
        endpoint,
        encryptedApiKey,
        keyVersion,
        enabled,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.credentialRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: saved.id,
        data: { provider, action: 'credential-set' },
      });
      return this.maskCredential(saved);
    }

    await this.updateEntity(existing, { endpoint, encryptedApiKey, keyVersion, enabled });
    const saved = await this.credentialRepository.update(existing.id, existing);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      data: { provider, action: 'credential-rotated' },
    });
    return this.maskCredential(saved);
  }

  /** Remove a tenant's BYO credential for a provider (soft delete). */
  async removeCredential(tenantId: string, provider: string): Promise<void> {
    const existing = await this.credentialRepository.findByTenantAndProvider(tenantId, provider);
    if (!existing) {
      throw new NotFoundException(`No ${provider} credential for this tenant`);
    }
    await this.credentialRepository.softDelete(existing.id);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: existing.id,
      data: { provider },
    });
  }

  /**
   * Decrypt a tenant's enabled BYO credentials into the injectable overrides map
   * (gateway-only — never exposed by a read API). Fails OPEN per credential: a
   * decrypt error (or no Vault) skips it, so tts-v2 falls back to platform creds.
   */
  async resolveProviderOverrides(tenantId: string): Promise<TtsProviderOverrides> {
    if (!this.secretsService) {
      return {};
    }
    const rows = await this.credentialRepository.findByTenantId(tenantId);
    const out: TtsProviderOverrides = {};
    for (const row of rows) {
      if (!row.enabled || !row.encryptedApiKey) {
        continue;
      }
      try {
        const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
        const entry: { api_key: string; region?: string; base_url?: string } = { api_key: apiKey };
        if (row.endpoint) {
          if (row.provider === 'azure') entry.region = row.endpoint;
          else if (row.provider === 'sarvam') entry.base_url = row.endpoint;
        }
        out[row.provider] = entry;
      } catch {
        continue;
      }
    }
    return out;
  }

  private maskCredential(entity: TenantTtsProviderCredentialEntity): TtsCredentialResponse {
    return {
      provider: entity.provider,
      endpoint: entity.endpoint ?? null,
      enabled: entity.enabled,
      hasKey: entity.encryptedApiKey != null && entity.encryptedApiKey.length > 0,
      keyVersion: entity.keyVersion ?? null,
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }
}
