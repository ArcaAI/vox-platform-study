import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { AiProviderConnectionResponse, IProviderConnectionService, UpsertAiProviderConnectionRequest } from '../ai-provider-connection';
import { PipelineResponse, PipelineService } from '../stt/pipeline';
import { ITenantSttConfigService } from './ITenantSttConfigService';
import { TenantSttConfigDtoMapper } from './tenant-stt-config.dto.mapper';
import {
  EffectiveSttConfigResponse,
  SetSttCredentialRequest,
  SetSttFallbackRequest,
  SttCredentialResponse,
  TenantSttConfigResponse,
  TestSttCredentialRequest,
  TestSttCredentialResponse,
} from './dto';
import {
  BATCH_ONLY_STT_FORMATS,
  BATCH_ONLY_STT_PROVIDERS,
  BYO_STT_PROVIDERS,
  CLOUD_STT_FORMATS,
  CLOUD_STT_PROVIDERS,
  resolveEffectiveSttConfig,
  SttProviderOverrides,
  SttSpecInput,
} from './platform-limits';

/** The capability discriminator this service resolves credentials under (C1/C2/C5). */
const STT_SERVICE = 'stt' as const;

/** "Test connection" probe timeout — generous enough for a slow link, short enough for a synchronous admin click. */
const TEST_CONNECTION_TIMEOUT_MS = 5_000;

/** Loopback / RFC1918 / link-local hostnames a tenant-supplied test target may not resolve to literally. */
const PRIVATE_HOST_PATTERN = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1]?$|localhost$)/i;

@Injectable()
export class TenantSttConfigService extends BaseService implements ITenantSttConfigService {
  private readonly logger = new Logger(TenantSttConfigService.name);

  constructor(
    private readonly configRepository: TenantSttConfigRepository,
    // Resolves the fallback pipeline's ASR model slug → cloud/local verdict.
    private readonly aiModelRepository: AiModelRepository,
    // Fallback-pipeline existence / tenant-visibility / status validation.
    private readonly pipelineService: PipelineService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // BYO credential storage — delegated to the UNIFIED provider-connection
    // plane (`service='stt'`, TASK-571). `AiProviderConnectionService` owns
    // Vault encryption/decryption, masking, OCC, and the
    // ResourceCreated/Updated/Deleted sys-event broadcasts for every credential
    // mutation; this service no longer touches Vault or a credential
    // repository/table directly — the legacy `TenantSttProviderCredential`
    // table and its domain trio were DROPPED by TASK-576 in favor of
    // `AiProviderConnection`.
    @Inject(IProviderConnectionService) private readonly providerConnectionService: IProviderConnectionService,
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
        ...(dto.consecutiveFailureThreshold !== undefined ? { configJson: { consecutiveFailureThreshold: dto.consecutiveFailureThreshold } } : {}),
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
      if (BATCH_ONLY_STT_PROVIDERS.has(provider)) {
        throw new BadRequestException(
          `Fallback pipeline '${pipeline.slug}' provider '${provider}' is batch-only and cannot be a live-streaming fallback`,
        );
      }
      return;
    }
    // Slug reference — resolve the AiModel (tenant copy, else SYSTEM catalog).
    const model = (await this.aiModelRepository.findBySlug(tenantId, asrRef)) ?? (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, asrRef));
    if (!model) {
      throw new BadRequestException(`Cannot resolve ASR model '${asrRef}' to verify pipeline '${pipeline.slug}' is cloud-backed`);
    }
    const isCloud = model.computeType === 'cloud' || CLOUD_STT_FORMATS.has(model.format);
    if (!isCloud) {
      throw new BadRequestException(`Fallback pipeline '${pipeline.slug}' is not cloud-engine-backed (ASR '${asrRef}')`);
    }
    if (BATCH_ONLY_STT_FORMATS.has(model.format)) {
      throw new BadRequestException(
        `Fallback pipeline '${pipeline.slug}' engine (ASR '${asrRef}') is batch-only and cannot be a live-streaming fallback`,
      );
    }
  }

  /**
   * Non-throwing counterpart of {@link assertCloudBacked}: `true` when the
   * pipeline's ASR engine is a valid live-streaming fallback — cloud-backed AND
   * NOT batch-only. Used to filter the fallback-candidate list (the picker should
   * only offer valid targets, not raise on the invalid ones). Same classification
   * rules — `provider::model` prefix or the resolved AiModel's compute type/format
   * — plus the batch-only exclusion (e.g. Azure Foundry / MAI-Transcribe), so a
   * batch-only engine never appears as a live fallback the switch can't perform.
   */
  private async isPipelineCloudBacked(tenantId: string, pipeline: PipelineResponse): Promise<boolean> {
    const asrRef = this.extractAsrRef(pipeline.configYaml);
    if (!asrRef) {
      return false;
    }
    if (asrRef.includes('::')) {
      const provider = asrRef.split('::')[0].trim().toLowerCase();
      return CLOUD_STT_PROVIDERS.has(provider) && !BATCH_ONLY_STT_PROVIDERS.has(provider);
    }
    const model = (await this.aiModelRepository.findBySlug(tenantId, asrRef)) ?? (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, asrRef));
    if (!model) {
      return false;
    }
    const isCloud = model.computeType === 'cloud' || CLOUD_STT_FORMATS.has(model.format);
    return isCloud && !BATCH_ONLY_STT_FORMATS.has(model.format);
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
      // Inline engine definition (e.g. Sarvam: `engine: "sarvam"` + `hf_model_id`).
      // The `engine` field names the provider DIRECTLY, so surface it as the
      // `provider::model` shorthand — the superset cloud engines (Sarvam/OpenAI)
      // have NO AiModel slug row, so the slug-lookup path below can never resolve
      // them and they'd be wrongly dropped from the fallback picker.
      const engine = asrObj['engine'];
      if (typeof engine === 'string' && engine.trim().length > 0) {
        const model = ['hf_model_id', 'model_id', 'model', 'slug', 'name', 'id']
          .map((k) => asrObj[k])
          .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        return `${engine.trim().toLowerCase()}::${(model ?? '').trim()}`;
      }
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

  // ─────────────────────── BYO credentials (unified plane, TASK-571) ───────────────────────

  /** Masked list of a tenant's BYO credentials (never the key). */
  async getCredentials(tenantId: string): Promise<SttCredentialResponse[]> {
    const rows = await this.providerConnectionService.list(STT_SERVICE, tenantId);
    return rows.map((row) => this.toCredentialResponse(row));
  }

  /**
   * Set or rotate a tenant's BYO key for a provider. Encryption, masking, OCC
   * (`expectedVersion: 0` creates, `>0` compare-and-sets — TASK-526
   * credential-OCC divergence from the TTS precedent), and the
   * ResourceCreated/ResourceUpdated sys-event broadcast are all owned by
   * `IProviderConnectionService.upsertRow('stt', ...)` now — this method only
   * translates the STT-shaped request/response.
   *
   * `enabled` needs a pre-read: the unified plane's own create default is
   * `false` (a fresh row starts disabled until explicitly turned on), but the
   * pre-unification STT default was `true` on CREATE while an omitted
   * `enabled` on an UPDATE (rotate) left the row's current flag untouched. A
   * lightweight `getRow` (masked, non-secret) tells create from update apart so
   * that default is reproduced exactly; the write remains a single
   * `upsertRow` call.
   */
  async setCredential(tenantId: string, provider: string, dto: SetSttCredentialRequest): Promise<SttCredentialResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    if (!(BYO_STT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unsupported BYO provider '${provider}'. Expected: ${BYO_STT_PROVIDERS.join(', ')}`);
    }

    const existing = await this.providerConnectionService.getRow(STT_SERVICE, provider, tenantId);
    const isCreate = existing.version === 0;

    const upsertDto: UpsertAiProviderConnectionRequest = {
      baseUrl: dto.endpoint,
      region: dto.region,
      apiKey: dto.apiKey,
      enabled: dto.enabled ?? (isCreate ? true : undefined),
      extraJson: dto.model !== undefined ? { model: dto.model } : undefined,
    };
    const saved = await this.providerConnectionService.upsertRow(STT_SERVICE, provider, upsertDto, tenantId, dto.expectedVersion);
    return this.toCredentialResponse(saved);
  }

  /**
   * Remove a tenant's BYO credential for a provider (soft delete via the
   * unified plane). `deleteRow` already 404s an absent row — same class the
   * pre-unification direct-repository check threw.
   */
  async removeCredential(tenantId: string, provider: string): Promise<void> {
    await this.providerConnectionService.deleteRow(STT_SERVICE, provider, tenantId);
  }

  // ─────────────────────── ephemeral "Test connection" probe ───────────────────────

  /**
   * Validate an apiKey/region/endpoint combination against the live provider
   * BEFORE it is saved. Never persists anything, never touches Vault, never
   * logs the key. Mirrors `TenantIdpConfigService.testConnection`'s house
   * pattern: a real auth-only probe where the provider exposes one (OpenAI's
   * `/models`, classic Azure Speech's STS token issuance), a reachability-only
   * "config-consistency smoke test" where it doesn't (Azure Foundry, Sarvam —
   * both require a real audio payload to verify the key, per
   * `apps/stt/src/stt/streaming/{sarvam,openai}_asr.py` /
   * `apps/stt/src/stt/models/azure_foundry_loader.py`).
   */
  async testCredential(tenantId: string, provider: string, dto: TestSttCredentialRequest): Promise<TestSttCredentialResponse> {
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    if (!(BYO_STT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unsupported BYO provider '${provider}'. Expected: ${BYO_STT_PROVIDERS.join(', ')}`);
    }
    switch (provider) {
      case 'openai':
        return this.testOpenAiConnection(dto);
      case 'azure-speech':
        return this.testAzureSpeechConnection(dto);
      case 'sarvam':
        return this.testSarvamConnection(dto);
      default:
        throw new BadRequestException(`Unsupported BYO provider '${provider}'`);
    }
  }

  /** Real auth-only probe: `GET {base_url}/models` with the bearer key. */
  private async testOpenAiConnection(dto: TestSttCredentialRequest): Promise<TestSttCredentialResponse> {
    const base = this.assertPublicHttpsUrl(dto.endpoint?.trim() || 'https://api.openai.com/v1', 'endpoint');
    const target = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/models`);
    try {
      const response = await fetch(target, {
        headers: { Authorization: `Bearer ${dto.apiKey}` },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, message: 'Connected — key accepted' };
      if (response.status === 401 || response.status === 403) return { ok: false, message: 'Rejected — invalid API key' };
      return { ok: false, message: `Provider responded ${response.status}` };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.probeErrorMessage(error)}` };
    }
  }

  /**
   * Classic Azure Speech (region present): a real auth-only probe via the STS
   * token-issuance endpoint. Azure Foundry (endpoint present, no region): no
   * auth-only route exists (the transcribe endpoint requires real audio), so
   * this degrades to a reachability-only smoke test.
   */
  private async testAzureSpeechConnection(dto: TestSttCredentialRequest): Promise<TestSttCredentialResponse> {
    const region = dto.region?.trim();
    if (region) {
      if (!/^[a-z0-9-]+$/i.test(region)) {
        throw new BadRequestException('region must be a simple region slug (e.g. eastus)');
      }
      const target = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`;
      try {
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'Ocp-Apim-Subscription-Key': dto.apiKey, 'Content-Length': '0' },
          signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true, message: 'Connected — subscription key accepted' };
        if (response.status === 401 || response.status === 403) return { ok: false, message: 'Rejected — invalid subscription key or region' };
        return { ok: false, message: `Provider responded ${response.status}` };
      } catch (error) {
        return { ok: false, message: `Could not reach provider: ${this.probeErrorMessage(error)}` };
      }
    }

    const endpoint = dto.endpoint?.trim();
    if (endpoint) {
      const url = this.assertPublicHttpsUrl(endpoint, 'endpoint');
      try {
        await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS) });
        return { ok: true, message: 'Endpoint reachable — Foundry has no auth-only probe; the key is verified on first transcription' };
      } catch (error) {
        return { ok: false, message: `Could not reach endpoint: ${this.probeErrorMessage(error)}` };
      }
    }

    throw new BadRequestException('Provide a region (classic Azure Speech) or an endpoint (Azure Foundry) to test');
  }

  /** No auth-only route is documented for Sarvam — reachability-only smoke test. */
  private async testSarvamConnection(dto: TestSttCredentialRequest): Promise<TestSttCredentialResponse> {
    const url = this.assertPublicHttpsUrl(dto.endpoint?.trim() || 'https://api.sarvam.ai', 'endpoint');
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { 'api-subscription-key': dto.apiKey },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (response.status >= 500) return { ok: false, message: `Provider responded ${response.status}` };
      return { ok: true, message: 'Endpoint reachable — Sarvam has no auth-only probe; the key is verified on first transcription' };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.probeErrorMessage(error)}` };
    }
  }

  /**
   * SSRF guard for a tenant-supplied probe target: https only, and the
   * hostname may not be a loopback/private/link-local address. Best-effort —
   * it inspects the literal hostname, not DNS resolution — but this is an
   * admin (tenant-manage-scoped) self-service probe of the TENANT'S OWN
   * configuration, not attacker-controlled input from an untrusted caller.
   */
  private assertPublicHttpsUrl(raw: string, fieldLabel: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException(`${fieldLabel} must be a valid URL`);
    }
    if (url.protocol !== 'https:') {
      throw new BadRequestException(`${fieldLabel} must use https`);
    }
    if (PRIVATE_HOST_PATTERN.test(url.hostname)) {
      throw new BadRequestException(`${fieldLabel} may not target a private/loopback address`);
    }
    return url;
  }

  private probeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Decrypt a tenant's enabled BYO credentials into the injectable overrides map
   * (gateway-only — never exposed by a read API). Decryption, the no-Vault `{}`
   * short-circuit, and the fail-OPEN-per-credential non-secret warn
   * (`{tenantId, service, provider, keyVersion}`) are all owned by
   * `resolveTenantCloudOverrides('stt', tenantId)` now.
   *
   * The unified entry shape (`api_key`, `base_url?`, `region?`, `api_version?`,
   * `deployment_name?`) has no `model` field — STT-only (Foundry/Sarvam/OpenAI
   * model id). It is folded in here from the same rows' masked `extraJson` (a
   * second, non-secret `list()` call), so the injectable shape this method
   * returns is unchanged: `{api_key, region?, base_url?, model?}`.
   */
  async resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides> {
    const overrides = await this.providerConnectionService.resolveTenantCloudOverrides(STT_SERVICE, tenantId);
    const providers = Object.keys(overrides);
    if (providers.length === 0) {
      return {};
    }

    const rows = await this.providerConnectionService.list(STT_SERVICE, tenantId);
    const modelByProvider = new Map(rows.map((row) => [row.provider, this.extractModel(row.extraJson)]));

    const out: SttProviderOverrides = {};
    for (const provider of providers) {
      const entry = overrides[provider];
      const model = modelByProvider.get(provider);
      out[provider] = {
        api_key: entry.api_key,
        ...(entry.region ? { region: entry.region } : {}),
        ...(entry.base_url ? { base_url: entry.base_url } : {}),
        ...(model ? { model } : {}),
      };
    }
    return out;
  }

  /** Unified masked response → the STT-shaped credential DTO. */
  private toCredentialResponse(row: AiProviderConnectionResponse): SttCredentialResponse {
    return {
      provider: row.provider,
      region: row.region,
      endpoint: row.baseUrl,
      model: this.extractModel(row.extraJson),
      enabled: row.enabled,
      hasKey: row.hasKey,
      keyVersion: row.keyVersion,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  /** `extraJson.model`, tolerating the pre-unification `foundryModel` key. */
  private extractModel(extraJson: Record<string, unknown> | null): string | null {
    const model = extraJson?.['model'] ?? extraJson?.['foundryModel'];
    return typeof model === 'string' && model.length > 0 ? model : null;
  }
}
