import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { uuidv7 } from 'uuidv7';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelEntity,
  AiModelRepository,
  AiModelSource,
  JobQueue,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import type { IProviderConnectionService as ProviderConnectionPort } from '../../ai-provider-connection/IProviderConnectionService';
import { IModelResidencyService } from '../../model-residency/IModelResidencyService';
import type { IModelResidencyService as ModelResidencyPort } from '../../model-residency/IModelResidencyService';
import type { ModelResidencyCatalogueResponse } from '../../model-residency/dto';
import { RESIDENCY_CONTROLLED_SERVICES, residencyServiceOf } from '../../model-residency/model-residency.types';
import { AiModelService } from '../aiModel.service';
import {
  CreateModelRequest,
  DownloadMissingResponse,
  HubPreviewQuery,
  HubPreviewResponse,
  ModelUsageResponse,
  RegisterFromHubRequest,
  RegisterFromHubResponse,
  UnregisterModelRequest,
  UnregisterModelResponse,
} from '../dto';
import { HuggingFaceModelSourceClient } from '../publish/huggingface-model-source.client';
import { claimAndEnqueueDownload, enqueuePublisherJob } from '../publish/ai-model-download.service';
import type { UnregisterAiModelJobPayload } from '../publish/publisher-job.contract';
import { mergeUnregisterMeta } from '../publish/model-download-meta.util';
import { effectiveStaleAfterMs, readModelDownloadSettings, type DownloadSettingsSource } from './model-download-settings';
import { buildHubPreview, categoryOf, providerFor, servedByFor } from './hub-preview.util';
import { isUnregistering, publishStatusOf } from './model-lifecycle.derive';
import { ModelUsageReader } from './model-usage.reader';
import { withDerivedServingFacts } from '../serving-spec/derive-serving-facts';
import { assertPlatformRegistryAdmin } from './platform-admin';

type ResidencyPort = Pick<ModelResidencyPort, 'getCatalogue' | 'unload'>;
type HubTokenPort = Pick<ProviderConnectionPort, 'findDefaultRow'>;

const S3_SOURCE = /^s3:\/\//;
const HF_CONFIGURE_HINT = 'Configure the platform Hugging Face token under AI providers → Model registry → Hugging Face.';

/** The HTTP status a Hub call failed with — from the transport error, or from the client's `(HTTP nnn)` message. */
function hubStatusOf(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number') return status;
  const match = error instanceof Error ? /\(HTTP (\d{3})\)/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

/** A catalogue entry for one model on one service, with the key the service holds it under. */
interface ResidentEntry {
  service: string;
  modelRef: string | null;
  status: string;
}

/**
 * Platform-admin OPERATIONS on the model registry (TASK-1019): register a
 * model straight from a Hugging Face repo id, see who uses a model, unregister
 * it (and delete its weights), and re-download every model whose weights are
 * missing from the bucket.
 *
 * Every method asserts a SUPER_ADMIN in a tenant-less context FIRST (D-11,
 * row-independent). Downloads and deletions are PRODUCED here and consumed by
 * the model-publisher worker (OD-1): the gateway only writes bookkeeping and
 * enqueues, it never touches the bucket.
 */
@Injectable()
export class ModelRegistryOperationsService extends BaseService {
  private readonly logger = new Logger(ModelRegistryOperationsService.name);

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly aiModelRepository: AiModelRepository,
    private readonly hub: HuggingFaceModelSourceClient,
    private readonly usage: ModelUsageReader,
    @InjectQueue(JobQueue.DownloadAiModel) private readonly publisherQueue: Queue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IModelResidencyService) private readonly residency?: ResidencyPort,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: HubTokenPort,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: DownloadSettingsSource,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  // ── Hub preview + register ──────────────────────────────────────────────────

  async previewHub(query: HubPreviewQuery): Promise<HubPreviewResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'preview a Hugging Face model');
    return this.readHub(query.repoId, query.revision ?? 'main');
  }

  async registerFromHub(request: RegisterFromHubRequest): Promise<RegisterFromHubResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'register a model');
    const preview = await this.readHub(request.repoId, request.revision ?? 'main');
    const s = preview.suggested;

    const slug = request.slug ?? preview.suggestedSlug;
    if (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug)) {
      throw new ConflictException({ code: 'SLUG_TAKEN', message: `A model with slug '${slug}' is already registered.` });
    }

    const format = request.format ?? preview.suggestedFormat;
    if (!format) throw new BadRequestException(`The artifact format of '${request.repoId}' could not be inferred from its files; pass 'format'.`);

    // A repo with no Hub pipeline tag suggests no task, so the preview's own
    // suggestions are empty; the task the admin CHOSE is then what decides the
    // serving workload, category and provider.
    const taskType = request.taskType ?? preview.taskType ?? null;
    const libraryName = request.libraryName ?? s.libraryName ?? null;
    const servedBy = request.servedBy ?? s.servedBy ?? servedByFor(taskType, libraryName);
    if (!servedBy) {
      throw new BadRequestException({
        code: 'SERVED_BY_REQUIRED',
        message: `Which service serves '${request.repoId}' could not be inferred from its task; choose 'servedBy'.`,
      });
    }
    const category = request.category ?? s.category ?? categoryOf(taskType);
    const provider = request.provider ?? s.provider ?? providerFor(servedBy);

    // The SAME create path and validation as `POST admin/ai-models`: the DTO is
    // validated with the pipe's own options, then `AiModelService.create` runs.
    const createDto = plainToInstance(CreateModelRequest, {
      name: request.name ?? preview.suggestedName,
      slug,
      ...(request.description !== undefined ? { description: request.description } : {}),
      category: category ?? ModelCategory.UNKNOWN,
      taskType: taskType ?? ModelTaskType.UNKNOWN,
      modelType: request.modelType ?? s.modelType ?? ModelType.UNKNOWN,
      source: AiModelSource.HUGGINGFACE,
      sourceUri: preview.sourceUri,
      sourceRevision: preview.commitSha,
      format,
      libraryName: libraryName ?? undefined,
      servedBy,
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      ...(preview.license ? { license: preview.license } : {}),
      gated: preview.gated,
      ...(preview.baseModel ? { baseModel: preview.baseModel } : {}),
      languages: preview.languages,
      ...(provider ? { provider } : {}),
      ...(request.architecture !== undefined ? { architecture: request.architecture } : {}),
      ...(request.computeType !== undefined ? { computeType: request.computeType } : {}),
      ...(request.memorySizeMb !== undefined ? { memorySizeMb: request.memorySizeMb } : {}),
      ...(request.tags !== undefined ? { tags: request.tags } : {}),
    });
    const errors = await validate(createDto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (errors.length > 0) {
      const detail = errors.flatMap((e) => Object.values(e.constraints ?? { [e.property]: `${e.property} is invalid` }));
      throw new BadRequestException({ code: 'INVALID_REGISTRATION', message: detail.join('; '), errors: detail });
    }

    const model = await this.aiModelService.create(createDto);

    const settings = readModelDownloadSettings(this.appSettings);
    const row = await this.findRegistryRow(model.id);
    // OD-9 — a vLLM-served row is servable at once: the derived `vramGiB` default rides on the
    // same update that claims the download (never overwriting a value already there).
    row.metaData = withDerivedServingFacts(row.metaData, { servedBy, weightBytes: preview.totalBytes }) ?? undefined;
    const { jobId } = await claimAndEnqueueDownload({ repository: this.aiModelRepository, queue: this.publisherQueue }, row, {
      userId: this.requestUserId,
      maxAttempts: settings.maxAttempts,
    });
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: model.id,
      data: { publishStatus: 'DOWNLOADING', jobId, registeredFrom: preview.sourceUri, revision: preview.commitSha },
    });

    return { model, jobId };
  }

  // ── Usage + unregister ──────────────────────────────────────────────────────

  async getUsage(id: string): Promise<ModelUsageResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'read who uses a model');
    const row = await this.findRegistryRow(id);
    const referrers = await this.usage.referrersOf(row);
    return { modelId: row.id, slug: row.slug, inUse: referrers.length > 0, referrers };
  }

  async unregister(id: string, request: UnregisterModelRequest = {}): Promise<UnregisterModelResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'unregister a model');
    const deleteWeights = request.deleteWeights ?? true;
    const purge = request.purge ?? false;
    const settings = readModelDownloadSettings(this.appSettings);

    const row = await this.findRegistryRow(id);
    if (isUnregistering(row.metaData)) {
      throw new ConflictException({ code: 'MODEL_UNREGISTERING', message: `Model '${row.slug}' is already being unregistered.` });
    }
    if (publishStatusOf(row, { now: Date.now(), staleAfterMs: effectiveStaleAfterMs(settings) }) === 'DOWNLOADING') {
      throw new ConflictException({
        code: 'DOWNLOAD_IN_PROGRESS',
        message: `Model '${row.slug}' is being downloaded; unregister it once the download settles.`,
      });
    }

    const referrers = await this.usage.referrersOf(row);
    if (referrers.length > 0) {
      throw new ConflictException({
        code: 'MODEL_IN_USE',
        message: `Model '${row.slug}' is still used by ${referrers.length} ${referrers.length === 1 ? 'item' : 'items'}; remove those references first.`,
        referrers,
      });
    }

    await this.unloadEverywhere(row);

    const weights = deleteWeights ? await this.weightsOutcome(row) : 'kept';
    const jobId = uuidv7();
    row.metaData = mergeUnregisterMeta(row.metaData, {
      jobId,
      startedAt: new Date().toISOString(),
      deleteWeights,
      purge,
      finishedAt: null,
      error: null,
      weights,
    });
    if (this.requestUserId) row.updatedBy = this.requestUserId;
    try {
      await this.aiModelRepository.updateWithVersion(row.id, row, row.version);
    } catch (error) {
      if (error instanceof OptimisticConcurrencyException) {
        throw new ConflictException({ code: 'MODEL_CHANGED', message: `Model '${row.slug}' changed while it was being unregistered; try again.` });
      }
      throw error;
    }

    const payload: UnregisterAiModelJobPayload = {
      kind: 'unregister',
      jobId,
      aiModelId: row.id,
      tenantId: SYSTEM_TENANT_ID,
      userId: this.requestUserId ?? undefined,
      // The caller's intent; the worker re-checks the shared-prefix rule (D-6) itself.
      deleteWeights,
      purge,
    };
    await enqueuePublisherJob(this.publisherQueue, payload, settings.maxAttempts);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: { action: 'unregister', slug: row.slug, jobId, weights, purge },
    });
    return { jobId, weights };
  }

  // ── Bootstrap: download every missing model ────────────────────────────────

  async downloadMissing(): Promise<DownloadMissingResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'download missing models');
    const settings = readModelDownloadSettings(this.appSettings);
    const now = Date.now();

    const rows = await this.aiModelRepository.findAll({
      filters: {
        tenantId: SYSTEM_TENANT_ID,
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        // Everything not known to be on disk. A freshly registered row starts
        // UNKNOWN and the cluster inventory cannot currently write MISSING, so a
        // MISSING-only query enqueued nothing (final review I6); PARTIAL is a
        // half-fetched copy worth completing.
        availability: { in: [AiModelAvailability.MISSING, AiModelAvailability.UNKNOWN, AiModelAvailability.PARTIAL] },
        resourceStatus: { not: ResourceStatusType.DELETED },
      } as never,
      sort: [{ slug: 'asc' }],
    });

    const out: DownloadMissingResponse = { enqueued: [], skipped: [] };
    for (const row of rows) {
      const skip = (reason: DownloadMissingResponse['skipped'][number]['reason']) => out.skipped.push({ id: row.id, slug: row.slug, reason });
      if (row.source !== AiModelSource.HUGGINGFACE && !S3_SOURCE.test(row.sourceUri ?? '')) {
        skip('SOURCE_NOT_FETCHABLE');
        continue;
      }
      if (isUnregistering(row.metaData)) {
        skip('UNREGISTERING');
        continue;
      }
      if (publishStatusOf(row, { now, staleAfterMs: effectiveStaleAfterMs(settings) }) === 'DOWNLOADING') {
        skip('DOWNLOADING');
        continue;
      }
      try {
        const { jobId } = await claimAndEnqueueDownload({ repository: this.aiModelRepository, queue: this.publisherQueue }, row, {
          userId: this.requestUserId,
          maxAttempts: settings.maxAttempts,
        });
        out.enqueued.push({ id: row.id, slug: row.slug, jobId });
      } catch (error) {
        if (error instanceof ConflictException) {
          skip('CONFLICT');
          continue;
        }
        throw error;
      }
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      data: { action: 'download-missing', enqueued: out.enqueued.length, skipped: out.skipped.length },
    });
    return out;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** A live SYSTEM registry row, or 404 (never another tenant's row, never a deleted one). */
  private async findRegistryRow(id: string): Promise<AiModelEntity> {
    const row = await this.aiModelRepository.findById(id).catch((error: unknown) => {
      if (error instanceof DataNotFoundException) return null;
      throw error;
    });
    if (!row || row.tenantId !== SYSTEM_TENANT_ID || row.resourceStatus === ResourceStatusType.DELETED) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    return row;
  }

  /** Whether a platform Hugging Face token is configured (enabled SYSTEM row carrying key material). No decrypt. */
  private async platformHubTokenConfigured(): Promise<boolean> {
    if (!this.providerConnections) return false;
    const row = await this.providerConnections.findDefaultRow('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    return !!row && row.enabled && !!row.encryptedApiKey && row.encryptedApiKey.length > 0;
  }

  private async readHub(repoId: string, revision: string): Promise<HubPreviewResponse> {
    const tokenConfigured = await this.platformHubTokenConfigured();
    let info: Awaited<ReturnType<HuggingFaceModelSourceClient['getRepoInfo']>>;
    let files: Awaited<ReturnType<HuggingFaceModelSourceClient['listRepoFiles']>>;
    try {
      [info, files] = await Promise.all([this.hub.getRepoInfo(repoId, revision), this.hub.listRepoFiles(repoId, revision)]);
    } catch (error) {
      const status = hubStatusOf(error);
      if (status === 404) throw new NotFoundException(`Hugging Face has no repo '${repoId}' at revision '${revision}'.`);
      if (status === 401 || status === 403) {
        // The Hub answers 401 both for a private/gated repo and — to an anonymous
        // caller — for one that does not exist, so without a token the honest
        // answer is "a token is required to see it".
        throw new UnprocessableEntityException(
          tokenConfigured
            ? {
                code: 'HF_TOKEN_REJECTED',
                message: `The platform Hugging Face token cannot read '${repoId}'. Accept the repo's terms with that account, or use a token that can.`,
              }
            : { code: 'HF_TOKEN_REQUIRED', message: `'${repoId}' is private, gated or does not exist. ${HF_CONFIGURE_HINT}` },
        );
      }
      this.logger.warn({ message: 'ai_model.hub_preview.failed', repoId, status });
      throw new BadGatewayException(`Hugging Face could not be reached for '${repoId}'.`);
    }
    if (info.gated && !tokenConfigured) {
      throw new UnprocessableEntityException({ code: 'HF_TOKEN_REQUIRED', message: `'${repoId}' is gated. ${HF_CONFIGURE_HINT}` });
    }
    return buildHubPreview({ repoId, revision, info, files });
  }

  /**
   * Unload the model from every service that holds it, then confirm (OD-3).
   * A service that cannot be commanded (stt-worker) or refuses (in-flight
   * requests) leaves it loaded, and that is a 409 — the weights are never
   * deleted from under a loaded model.
   */
  private async unloadEverywhere(row: AiModelEntity): Promise<void> {
    if (row.deploymentKind !== AiDeploymentKind.SELF_HOSTED || residencyServiceOf({ servedBy: row.servedBy, provider: row.provider }) === null)
      return;
    if (!this.residency) {
      throw new ConflictException({
        code: 'MODEL_UNLOAD_FAILED',
        message: 'The model residency plane is not available, so the model cannot be confirmed unloaded.',
        services: [],
      });
    }

    const resident = await this.residentEntries(row);
    const refusals: Array<{ service: string; reason: string }> = [];
    for (const entry of resident) {
      if (!(RESIDENCY_CONTROLLED_SERVICES as readonly string[]).includes(entry.service) || !entry.modelRef) {
        refusals.push({ service: entry.service, reason: 'This service cannot be told to unload models.' });
        continue;
      }
      try {
        await this.residency.unload({
          service: entry.service as (typeof RESIDENCY_CONTROLLED_SERVICES)[number],
          modelRef: entry.modelRef,
          force: false,
          reason: `unregister ${row.slug}`,
        });
      } catch (error) {
        refusals.push({ service: entry.service, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (resident.length === 0) return;

    const still = await this.residentEntries(row);
    if (still.length > 0) {
      throw new ConflictException({
        code: 'MODEL_UNLOAD_FAILED',
        message: `Model '${row.slug}' is still loaded on ${[...new Set(still.map((e) => e.service))].join(', ')}.`,
        services: still.map((e) => ({ service: e.service, state: e.status, reason: refusals.find((r) => r.service === e.service)?.reason ?? null })),
      });
    }
  }

  private async residentEntries(row: AiModelEntity): Promise<ResidentEntry[]> {
    let catalogue: ModelResidencyCatalogueResponse;
    try {
      catalogue = await this.residency!.getCatalogue();
    } catch (error) {
      throw new ConflictException({
        code: 'MODEL_UNLOAD_FAILED',
        message: `The model residency view could not be read, so '${row.slug}' cannot be confirmed unloaded: ${error instanceof Error ? error.message : String(error)}`,
        services: [],
      });
    }
    const out: ResidentEntry[] = [];
    for (const group of catalogue.services ?? []) {
      for (const model of group.models ?? []) {
        const matches = model.aiModelId ? model.aiModelId === row.id : model.slug === row.slug;
        if (matches && (model.status === 'loaded' || model.status === 'loading' || model.status === 'unloading')) {
          out.push({ service: String(group.service), modelRef: model.modelRef, status: model.status });
        }
      }
    }
    return out;
  }

  /** D-6 — a prefix another live row still uses is never deleted. */
  private async weightsOutcome(row: AiModelEntity): Promise<UnregisterModelResponse['weights']> {
    if (!row.bucketPrefix) return 'kept';
    const sharing = await this.aiModelRepository.findAll({
      filters: {
        tenantId: SYSTEM_TENANT_ID,
        bucketPrefix: row.bucketPrefix,
        id: { not: row.id },
        resourceStatus: { not: ResourceStatusType.DELETED },
      } as never,
    });
    return sharing.length > 0 ? 'kept-shared' : 'deleting';
  }
}
