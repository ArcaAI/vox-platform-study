import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { parse } from 'yaml';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
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
import { IProviderConnectionService } from '../ai-provider-connection';
import { PipelineResponse, PipelineService } from '../stt/pipeline';
import { ITenantSttConfigService } from './ITenantSttConfigService';
import { TenantSttConfigDtoMapper } from './tenant-stt-config.dto.mapper';
import { EffectiveSttConfigResponse, SetSttFallbackRequest, TenantSttConfigResponse } from './dto';
import {
  BATCH_ONLY_STT_FORMATS,
  BATCH_ONLY_STT_PROVIDERS,
  CLOUD_STT_FORMATS,
  CLOUD_STT_PROVIDERS,
  resolveEffectiveSttConfig,
  SttProviderOverrides,
  SttSpecInput,
} from './platform-limits';

/** The capability discriminator this service resolves credentials under (C1/C2/C5). */
const STT_SERVICE = 'stt' as const;

@Injectable()
/** @deprecated TASK-861 — removed in R4. `fallbackPipelineId` / `autoSwitchEnabled` become the ASR Agent's `fallback` block (`ResolvedAsrSpec.fallback`, `AsrAgentResolverService`); `resolveProviderOverrides` is superseded by `ProviderCredentialResolver` (TASK-862); no gateway route reads it any more — the batch-worker pull resolves through `AsrAgentResolverService.resolveProviderOverrides` (TASK-861 follow-up). */
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
    // plane (`service='stt'`). `AiProviderConnectionService` owns
    // Vault encryption/decryption, masking, OCC, and the
    // ResourceCreated/Updated/Deleted sys-event broadcasts for every credential
    // mutation; this service no longer touches Vault or a credential
    // repository/table directly — the legacy `TenantSttProviderCredential`
    // table and its domain trio were DROPPED by in favor of
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
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(existing, dto.expectedVersion);
    if (!existing.hasChanges) {
      // PUT is idempotent by contract (RFC 9110 §9.2.2): re-sending a value that is
      // already stored must yield the SAME observable result as the first send, not a
      // 400. Returning the current representation satisfies BOTH that and the
      // phantom-write rule — no version bump, no `updatedAt` rewrite, no
      // ResourceUpdated event. (PATCH routes keep throwing `ArgumentInvalidException`;
      // there "you sent me nothing to change" IS the documented answer.)
      // The OCC precondition above has already run, so a STALE token still gets 412
      // rather than a misleading 200.
      return TenantSttConfigDtoMapper.toResponse(existing);
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
   * a meaningful outage escape — ).
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

  // TASK-862: the BYO credential facade (`getCredentials` / `setCredential` /
  // `removeCredential`) and the STT-only `testCredential` probe are GONE. The
  // one credential editor is `admin/providers/:service/:provider` and the one
  // probe is `POST admin/providers/:service/:provider/test`
  // (`ProviderConnectionProbe`). Only the injection path below survives.

  /**
   * Decrypt a tenant's enabled BYO credentials into the injectable overrides map
   * (gateway-only — never exposed by a read API). Decryption, the no-Vault `{}`
   * short-circuit, and the fail-OPEN-per-credential non-secret warn
   * (`{tenantId, service, provider, keyVersion}`) are all owned by
   * `resolveTenantCloudOverrides('stt', tenantId)` now.
   *
   * The unified entry shape (`api_key`, `base_url?`, `region?`, `api_version?`,
   * `deployment_name?`) has no `model` field — STT-only (Foundry/Sarvam/OpenAI
   * model id). The resolver folds it in from the row's `extraJson` (tolerating
   * the pre-unification `foundryModel` spelling), so the injectable shape this
   * method returns is unchanged: `{api_key, funding, region?, base_url?, model?}`.
   *
   * Two things changed here and both are load-bearing:
   *
   *   1. `funding` is FORWARDED. This method rebuilds each entry field by
   *      field, so anything it does not copy is dropped; dropping the funding
   *      label would make every platform-funded STT call meter as tenant BYOK
   *      (zero COGS, baseline rate, never invoiced) with nothing to notice it.
   *   2. The second, `list()`-based model lookup is GONE. It was pinned to the
   *      caller's tenant, so a SYSTEM-sourced override silently lost its model
   *      id the moment the cascade started supplying one. The resolver reads
   *      the model from whichever row won, which is the only tier-correct
   *      source — and it saves a query.
   */
  async resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides> {
    const { overrides } = await this.providerConnectionService.resolveTenantCloudOverrides(STT_SERVICE, tenantId);

    const out: SttProviderOverrides = {};
    for (const [provider, entry] of Object.entries(overrides)) {
      out[provider] = {
        api_key: entry.api_key,
        funding: entry.funding,
        ...(entry.region ? { region: entry.region } : {}),
        ...(entry.base_url ? { base_url: entry.base_url } : {}),
        ...(entry.model ? { model: entry.model } : {}),
      };
    }
    return out;
  }
}
