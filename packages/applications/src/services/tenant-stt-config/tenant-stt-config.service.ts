import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { parse } from 'yaml';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelRepository,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  SYSTEM_TENANT_ID,
  TenantSttConfigEntity,
  TenantSttConfigFactory,
  TenantSttConfigRepository,
  TenantSttProviderCredentialEntity,
  TenantSttProviderCredentialFactory,
  TenantSttProviderCredentialRepository,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { PipelineResponse, PipelineService } from '../stt/pipeline';
import { decryptSecretField, encryptSecretField, SecretsService } from '../baseServices/_meta/secrets';
import { ITenantSttConfigService } from './ITenantSttConfigService';
import { TenantSttConfigDtoMapper } from './tenant-stt-config.dto.mapper';
import {
  EffectiveSttConfigResponse,
  SetSttCredentialRequest,
  SetSttFallbackRequest,
  SttCredentialResponse,
  TenantSttConfigResponse,
} from './dto';
import {
  BYO_STT_PROVIDERS,
  CLOUD_STT_FORMATS,
  CLOUD_STT_PROVIDERS,
  resolveEffectiveSttConfig,
  SttProviderOverrides,
  SttSpecInput,
} from './platform-limits';

@Injectable()
export class TenantSttConfigService extends BaseService implements ITenantSttConfigService {
  private readonly logger = new Logger(TenantSttConfigService.name);

  constructor(
    private readonly configRepository: TenantSttConfigRepository,
    private readonly credentialRepository: TenantSttProviderCredentialRepository,
    // Resolves the fallback pipeline's ASR model slug → cloud/local verdict.
    private readonly aiModelRepository: AiModelRepository,
    // Fallback-pipeline existence / tenant-visibility / status validation.
    private readonly pipelineService: PipelineService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // BYO-key encryption. Optional so non-Vault deploys still run the fallback
    // spec; credential writes then reject (no plaintext-at-rest fallback).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantSttConfig);
  }

  async getRow(tenantId: string): Promise<TenantSttConfigResponse> {
    const row = await this.configRepository.findByTenantId(tenantId);
    return row ? TenantSttConfigDtoMapper.toResponse(row) : TenantSttConfigDtoMapper.placeholder(tenantId);
  }

  async getEffective(tenantId: string): Promise<EffectiveSttConfigResponse> {
    const [systemRow, tenantRow] = await Promise.all([
      this.configRepository.findByTenantId(SYSTEM_TENANT_ID),
      this.configRepository.findByTenantId(tenantId),
    ]);
    const effective = resolveEffectiveSttConfig(this.toSpec(systemRow), this.toSpec(tenantRow));
    return { tenantId, ...effective };
  }

  async setFallbackPipeline(tenantId: string, dto: SetSttFallbackRequest): Promise<TenantSttConfigResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Validate the fallback target when one is being set (null clears it).
    if (dto.fallbackPipelineId != null) {
      await this.assertValidFallbackPipeline(tenantId, dto.fallbackPipelineId);
    }

    const existing = await this.configRepository.findByTenantId(tenantId);

    if (!existing) {
      // No row yet — a create. The client must declare `expectedVersion: 0`.
      if (dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('TenantSttConfig', tenantId, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = TenantSttConfigFactory.CreateTenantSttConfig({
        tenantId,
        fallbackPipelineId: dto.fallbackPipelineId ?? null,
        ...(dto.autoSwitchEnabled !== undefined ? { autoSwitchEnabled: dto.autoSwitchEnabled } : {}),
        ...(dto.consecutiveFailureThreshold !== undefined
          ? { configJson: { consecutiveFailureThreshold: dto.consecutiveFailureThreshold } }
          : {}),
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.configRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
      });
      return TenantSttConfigDtoMapper.toResponse(saved);
    }

    const changes: Record<string, unknown> = {};
    if (dto.fallbackPipelineId !== undefined) changes.fallbackPipelineId = dto.fallbackPipelineId;
    if (dto.autoSwitchEnabled !== undefined) changes.autoSwitchEnabled = dto.autoSwitchEnabled;
    if (dto.consecutiveFailureThreshold !== undefined) {
      changes.configJson = { ...(existing.configJson ?? {}), consecutiveFailureThreshold: dto.consecutiveFailureThreshold };
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
    return TenantSttConfigDtoMapper.toResponse(updated);
  }

  /** Entity → nullable spec shape for the resolver. */
  private toSpec(entity: TenantSttConfigEntity | null): SttSpecInput | null {
    if (!entity) return null;
    const threshold = entity.configJson?.['consecutiveFailureThreshold'];
    return {
      fallbackPipelineId: entity.fallbackPipelineId ?? null,
      autoSwitchEnabled: entity.autoSwitchEnabled,
      consecutiveFailureThreshold: typeof threshold === 'number' ? threshold : null,
    };
  }

  // ─────────────────────── fallback-pipeline validation ───────────────────────

  /**
   * The fallback target must exist, be tenant-visible (a cross-tenant id resolves
   * to null via the extended client → 404, honouring the 404-over-403 posture),
   * be ENABLED, and be backed by a cloud ASR engine (a local GPU pipeline is not
   * a meaningful outage escape — §3.2).
   */
  private async assertValidFallbackPipeline(tenantId: string, pipelineId: string): Promise<void> {
    const pipeline = await this.pipelineService.getById(pipelineId);
    if (!pipeline) {
      throw new NotFoundException(`Fallback pipeline '${pipelineId}' not found`);
    }
    if (pipeline.resourceStatus !== ResourceStatusType.ENABLED) {
      throw new BadRequestException(`Fallback pipeline '${pipelineId}' must be ENABLED`);
    }
    await this.assertCloudBacked(tenantId, pipeline);
  }

  /** Reject a fallback whose ASR engine is not cloud-backed. */
  private async assertCloudBacked(tenantId: string, pipeline: PipelineResponse): Promise<void> {
    const asrRef = this.extractAsrRef(pipeline.configYaml);
    if (!asrRef) {
      throw new BadRequestException(`Fallback pipeline '${pipeline.slug}' has no ASR model reference`);
    }
    // Schema-v2 `provider::model` shorthand — the prefix is the engine provider.
    if (asrRef.includes('::')) {
      const provider = asrRef.split('::')[0].trim().toLowerCase();
      if (!CLOUD_STT_PROVIDERS.has(provider)) {
        throw new BadRequestException(`Fallback pipeline '${pipeline.slug}' provider '${provider}' is not a cloud STT engine`);
      }
      return;
    }
    // Slug reference — resolve the AiModel (tenant copy, else SYSTEM catalog).
    const model =
      (await this.aiModelRepository.findBySlug(tenantId, asrRef)) ??
      (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, asrRef));
    if (!model) {
      throw new BadRequestException(`Cannot resolve ASR model '${asrRef}' to verify pipeline '${pipeline.slug}' is cloud-backed`);
    }
    const isCloud = model.computeType === 'cloud' || CLOUD_STT_FORMATS.has(model.format);
    if (!isCloud) {
      throw new BadRequestException(`Fallback pipeline '${pipeline.slug}' is not cloud-engine-backed (ASR '${asrRef}')`);
    }
  }

  /**
   * Non-throwing counterpart of {@link assertCloudBacked}: `true` when the
   * pipeline's ASR engine is cloud-backed. Used to filter the fallback-candidate
   * list (the picker should only offer valid targets, not raise on the invalid
   * ones). Same classification rules — `provider::model` prefix or the resolved
   * AiModel's compute type/format.
   */
  private async isPipelineCloudBacked(tenantId: string, pipeline: PipelineResponse): Promise<boolean> {
    const asrRef = this.extractAsrRef(pipeline.configYaml);
    if (!asrRef) {
      return false;
    }
    if (asrRef.includes('::')) {
      const provider = asrRef.split('::')[0].trim().toLowerCase();
      return CLOUD_STT_PROVIDERS.has(provider);
    }
    const model =
      (await this.aiModelRepository.findBySlug(tenantId, asrRef)) ??
      (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, asrRef));
    if (!model) {
      return false;
    }
    return model.computeType === 'cloud' || CLOUD_STT_FORMATS.has(model.format);
  }

  /**
   * The pipelines a tenant may legitimately point its fallback at: enabled (the
   * shared `getAll` is enabled-only) AND cloud-engine-backed. Reuses the same
   * cloud-backed classification `setFallbackPipeline` validates on write, so the
   * picker never offers a target the PUT would reject.
   */
  async getFallbackCandidates(tenantId: string): Promise<PipelineResponse[]> {
    const pipelines = await this.pipelineService.getAll();
    const candidates: PipelineResponse[] = [];
    for (const pipeline of pipelines) {
      if (await this.isPipelineCloudBacked(tenantId, pipeline)) {
        candidates.push(pipeline);
      }
    }
    return candidates;
  }

  /** Extract the `models.asr` reference string from a pipeline's config YAML. */
  private extractAsrRef(configYaml: string): string | null {
    let root: unknown;
    try {
      root = parse(configYaml);
    } catch {
      return null;
    }
    const models = this.asRecord(this.asRecord(root)?.['models']);
    const asr = models?.['asr'];
    if (typeof asr === 'string' && asr.trim().length > 0) {
      return asr.trim();
    }
    const asrObj = this.asRecord(asr);
    if (asrObj) {
      for (const key of ['slug', 'model_id', 'hf_model_id', 'name', 'id']) {
        const candidate = asrObj[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
    }
    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  // ─────────────────────── BYO credentials ───────────────────────

  /** Masked list of a tenant's BYO credentials (never the key). */
  async getCredentials(tenantId: string): Promise<SttCredentialResponse[]> {
    const rows = await this.credentialRepository.findByTenantId(tenantId);
    return rows.map((row) => this.maskCredential(row));
  }

  /**
   * Set or rotate a tenant's BYO key for a provider (encrypted at rest). OCC via
   * `updateWithVersion` — `expectedVersion: 0` creates, `>0` compare-and-sets
   * (TASK-526 credential-OCC divergence from the TTS precedent).
   */
  async setCredential(tenantId: string, provider: string, dto: SetSttCredentialRequest): Promise<SttCredentialResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    if (!(BYO_STT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unsupported BYO provider '${provider}'. Expected: ${BYO_STT_PROVIDERS.join(', ')}`);
    }
    if (!this.secretsService) {
      throw new BadRequestException('BYO provider keys require the Vault secrets provider (SECRETS_PROVIDER=vault).');
    }

    const existing = await this.credentialRepository.findByTenantAndProvider(tenantId, provider);

    if (!existing) {
      if (dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('TenantSttProviderCredential', `${tenantId}:${provider}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      // Encrypt AFTER the precondition verdict (a stale-If-Match with Vault down
      // must surface as 412, not a 500 from the Transit call).
      const { ciphertext: encryptedApiKey, keyVersion } = await encryptSecretField(this.secretsService, dto.apiKey);
      const entity = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
        tenantId,
        provider,
        region: dto.region ?? null,
        endpoint: dto.endpoint ?? null,
        encryptedApiKey,
        keyVersion,
        enabled: dto.enabled ?? true,
        extraJson: dto.model ? { model: dto.model } : null,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.credentialRepository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        data: { provider, action: 'credential-set' },
      });
      return this.maskCredential(saved);
    }

    // CAS fast-fail against the row just read, BEFORE the Vault call.
    if (dto.expectedVersion !== existing.version) {
      throw new OptimisticConcurrencyException('TenantSttProviderCredential', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }

    const { ciphertext: encryptedApiKey, keyVersion } = await encryptSecretField(this.secretsService, dto.apiKey);
    const changes: Record<string, unknown> = { encryptedApiKey, keyVersion };
    if (dto.region !== undefined) changes.region = dto.region;
    if (dto.endpoint !== undefined) changes.endpoint = dto.endpoint;
    if (dto.enabled !== undefined) changes.enabled = dto.enabled;
    if (dto.model !== undefined) changes.extraJson = { ...(existing.extraJson ?? {}), model: dto.model };

    await this.updateEntity(existing, changes);
    const previousVersion = existing.version;
    const saved = await this.credentialRepository.updateWithVersion(existing.id, existing, dto.expectedVersion);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: saved.id,
      data: { provider, previousVersion, newVersion: saved.version, action: 'credential-rotated' },
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
   * decrypt error (or no Vault) skips it, so apps/stt falls back to platform
   * env creds. On a decrypt error a NON-SECRET warn is logged with ONLY
   * `{tenantId, provider, keyVersion}` — the deliberate improvement over the TTS
   * silent catch (§3.3).
   */
  async resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides> {
    if (!this.secretsService) {
      return {};
    }
    const rows = await this.credentialRepository.findByTenantId(tenantId);
    const out: SttProviderOverrides = {};
    for (const row of rows) {
      if (!row.enabled || !row.encryptedApiKey) {
        continue;
      }
      try {
        const apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
        const entry: SttProviderOverrides[string] = { api_key: apiKey };
        if (row.region) entry.region = row.region;
        if (row.endpoint) entry.base_url = row.endpoint;
        const model = row.extraJson?.['model'] ?? row.extraJson?.['foundryModel'];
        if (typeof model === 'string' && model.length > 0) entry.model = model;
        out[row.provider] = entry;
      } catch {
        // Non-secret warn only — never the key or ciphertext.
        this.logger.warn({
          message: 'stt.byo.decrypt_failed',
          tenantId,
          provider: row.provider,
          keyVersion: row.keyVersion ?? null,
        });
        continue;
      }
    }
    return out;
  }

  private maskCredential(entity: TenantSttProviderCredentialEntity): SttCredentialResponse {
    const model = entity.extraJson?.['model'] ?? entity.extraJson?.['foundryModel'];
    return {
      provider: entity.provider,
      region: entity.region ?? null,
      endpoint: entity.endpoint ?? null,
      model: typeof model === 'string' ? model : null,
      enabled: entity.enabled,
      hasKey: entity.encryptedApiKey != null && entity.encryptedApiKey.length > 0,
      keyVersion: entity.keyVersion ?? null,
      version: entity.version,
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }
}
