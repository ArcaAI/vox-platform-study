import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
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
  TtsCredentialResponse,
  UpdateTenantTtsConfigRequest,
} from './dto';
import { BYO_PROVIDERS, resolveEffectiveTtsConfig, TtsProviderOverrides, TtsSpecInput } from './platform-limits';

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
    const [systemRow, tenantRow] = await Promise.all([
      this.configRepository.findByTenantId(SYSTEM_TENANT_ID),
      this.configRepository.findByTenantId(tenantId),
    ]);
    const effective = resolveEffectiveTtsConfig(this.toSpec(systemRow), this.toSpec(tenantRow));
    return { tenantId, ...effective };
  }

  async upsertRow(tenantId: string, dto: UpdateTenantTtsConfigRequest): Promise<TenantTtsConfigResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
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
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.configRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
      });
      return TenantTtsConfigDtoMapper.toResponse(saved);
    }

    await this.updateEntity(existing, this.pickSpec(dto));
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

  // ─────────────────────── BYO credentials (Phase 6) ───────────────────────

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
