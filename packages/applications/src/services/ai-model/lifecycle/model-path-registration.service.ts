import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AiDeploymentKind,
  AiModelFormat,
  AiModelRepository,
  AiModelSource,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IS3Service } from '../../baseServices/storage';
import { AiModelDtoMapper } from '../aiModel.dto.mapper';
import { AiModelService } from '../aiModel.service';
import { HOPE_MODELS_BUCKET, normaliseBucketPath, SINGLE_FILE_LIBRARIES } from '../constants';
import { CreateModelRequest, LocalModelPreviewResponse, ModelResponse, RegisterFromPathRequest } from '../dto';
import { withDerivedServingFacts } from '../serving-spec/derive-serving-facts';
import { categoryOf, providerFor, servedByFor } from './hub-preview.util';
import {
  buildLocalModelPreview,
  isHfRepoDirPrefix,
  LOCAL_CONFIG_OBJECT,
  localSourceUriFor,
  primaryObjectFor,
  type LocalModelFile,
} from './local-model-preview';
import { assertPlatformRegistryAdmin } from './platform-admin';

type BucketPort = Pick<IS3Service, 'listFiles' | 'getFile'>;
interface BucketObject {
  key: string;
  size?: number;
}

/** A `config.json` larger than this is not a transformers config; it is not read. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** What one inspection of a bucket path found: the preview, plus the file the admin named (if any). */
interface Inspection {
  preview: LocalModelPreviewResponse;
  namedFile: string | null;
}

/**
 * Register a model whose weights are ALREADY in the models bucket (TASK-1023 R4c): preview a
 * path, then register it as a platform (SYSTEM) row with `source = LOCAL` — nothing is downloaded.
 *
 * Everything is derived from the objects under the path (layout, snapshot sha, primary object,
 * task, library, format, serving workload, architecture, dtype); an admin input remains only as
 * an OVERRIDE for a genuinely ambiguous artifact. Both methods assert a platform admin (SUPER_ADMIN,
 * no working tenant) FIRST — row-independent, so it runs before the bucket is read.
 */
@Injectable()
export class ModelPathRegistrationService extends BaseService {
  private readonly logger = new Logger(ModelPathRegistrationService.name);

  constructor(
    private readonly aiModelService: AiModelService,
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IS3Service) private readonly bucket: BucketPort,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  async previewLocal(path: string): Promise<LocalModelPreviewResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'preview a model in the models bucket');
    return (await this.inspect(path)).preview;
  }

  async registerFromPath(request: RegisterFromPathRequest): Promise<ModelResponse> {
    assertPlatformRegistryAdmin(this.requestUser, this.tenantId, 'register a model');
    const { preview, namedFile } = await this.inspect(request.path);
    const s = preview.suggested;

    const slug = request.slug ?? s.slug;
    if (await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug)) {
      throw new ConflictException({ code: 'SLUG_TAKEN', message: `A model with slug '${slug}' is already registered.` });
    }

    const taskType = (request.taskType ?? s.taskType ?? null) as ModelTaskType | null;
    const libraryName = request.libraryName ?? s.libraryName;
    const format = (request.format ?? s.format ?? null) as AiModelFormat | null;
    const servedBy = request.servedBy ?? s.servedBy ?? servedByFor(taskType, libraryName);
    if (!servedBy) {
      throw new BadRequestException({
        code: 'SERVED_BY_REQUIRED',
        message: `Which service serves '${preview.bucketPrefix}' could not be inferred from its files; choose 'servedBy'.`,
      });
    }
    if (!libraryName) {
      throw new BadRequestException({
        code: 'LIBRARY_REQUIRED',
        message: `The serving library of '${preview.bucketPrefix}' could not be inferred from its files; choose 'libraryName'.`,
      });
    }
    if (!format) {
      throw new BadRequestException({
        code: 'FORMAT_REQUIRED',
        message: `The artifact format of '${preview.bucketPrefix}' could not be inferred from its files; choose 'format'.`,
      });
    }
    // An overridden library may be single-file where the derived one was not: recompute.
    const primaryObject = primaryObjectFor(libraryName, preview.files, namedFile);
    if (primaryObject === null && SINGLE_FILE_LIBRARIES.has(libraryName)) {
      throw new BadRequestException({
        code: 'PRIMARY_OBJECT_REQUIRED',
        message: `'${libraryName}' loads one file, and '${preview.bucketPrefix}' does not hold exactly one candidate; choose the file itself as the path.`,
      });
    }

    const quantized = format === AiModelFormat.GGUF || format === AiModelFormat.WHISPER_CPP;
    const provider = providerFor(servedBy);
    const createDto = plainToInstance(CreateModelRequest, {
      name: request.name ?? s.name,
      slug,
      category: categoryOf(taskType) ?? ModelCategory.UNKNOWN,
      taskType: taskType ?? ModelTaskType.UNKNOWN,
      modelType: quantized ? ModelType.QUANTIZED_MODEL : ModelType.UNKNOWN,
      source: AiModelSource.LOCAL,
      sourceUri: localSourceUriFor(preview.bucketPrefix),
      format,
      libraryName,
      servedBy,
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      bucketPrefix: preview.bucketPrefix,
      ...(primaryObject ? { primaryObject } : {}),
      ...(preview.revision ? { hfRevision: preview.revision } : {}),
      ...(provider ? { provider } : {}),
      ...(s.architecture ? { architecture: s.architecture } : {}),
      ...(s.computeType ? { computeType: s.computeType } : {}),
    });
    const errors = await validate(createDto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (errors.length > 0) {
      const detail = errors.flatMap((e) => Object.values(e.constraints ?? { [e.property]: `${e.property} is invalid` }));
      throw new BadRequestException({ code: 'INVALID_REGISTRATION', message: detail.join('; '), errors: detail });
    }

    const model = await this.aiModelService.create(createDto);

    // OD-9 — a vLLM-served row is servable at once: the derived `vramGiB` default, never overwriting.
    const row = await this.aiModelRepository.findById(model.id);
    const metaData = withDerivedServingFacts(row.metaData, { servedBy, weightBytes: preview.totalBytes });
    if (metaData === row.metaData) return model;

    row.metaData = metaData ?? undefined;
    if (this.requestUserId) row.updatedBy = this.requestUserId;
    const updated = await this.aiModelRepository.updateWithVersion(row.id, row, row.version);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: row.id,
      data: { action: 'serving-facts-derived', slug: row.slug, vramGiB: (metaData as { serving: { vramGiB: number } }).serving.vramGiB },
    });
    return AiModelDtoMapper.toResponse(updated);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Resolve `path` to a folder in the bucket and derive its preview. A path naming an OBJECT
   * registers that object's folder, with the object as the primary file. An HF cache repo
   * directory with exactly one snapshot resolves to that snapshot.
   */
  private async inspect(path: string): Promise<Inspection> {
    let prefix = normaliseBucketPath(path);
    const exactKey = prefix.slice(0, -1);
    let namedFile: string | null = null;

    // One listing under the key without its slash answers both "a folder?" and "an object?".
    const listed = await this.list(exactKey);
    let objects = listed.filter((o) => o.key.startsWith(prefix));
    if (objects.filter((o) => !o.key.endsWith('/')).length === 0) {
      if (!listed.some((o) => o.key === exactKey)) {
        throw new NotFoundException({ code: 'PATH_EMPTY', message: `Nothing is stored under '${prefix}' in the models bucket.` });
      }
      const slash = exactKey.lastIndexOf('/');
      if (slash < 0) {
        throw new BadRequestException({ code: 'PATH_INVALID', message: `'${exactKey}' is at the bucket root; a model must live in a folder.` });
      }
      prefix = exactKey.slice(0, slash + 1);
      namedFile = exactKey.slice(slash + 1);
      objects = await this.list(prefix);
    }

    if (isHfRepoDirPrefix(prefix)) {
      const snapshots = [
        ...new Set(objects.map((o) => /^([^/]+\/[^/]+\/[^/]+\/snapshots\/[^/]+\/)/.exec(o.key)?.[1]).filter((p): p is string => !!p)),
      ];
      if (snapshots.length !== 1) {
        throw new BadRequestException({
          code: 'PATH_INVALID',
          message: `'${prefix}' is a Hugging Face cache repo with ${snapshots.length} snapshots; choose one snapshot folder.`,
        });
      }
      prefix = snapshots[0];
      objects = objects.filter((o) => o.key.startsWith(prefix));
    }

    const files: LocalModelFile[] = objects
      .filter((o) => !o.key.endsWith('/'))
      .map((o) => ({ key: o.key.slice(prefix.length), size: typeof o.size === 'number' ? o.size : 0 }));
    const config = await this.readConfig(prefix, files);

    return { preview: buildLocalModelPreview({ bucketPrefix: prefix, files, config, namedFile }), namedFile };
  }

  private async list(prefix: string): Promise<BucketObject[]> {
    return ((await this.bucket.listFiles(HOPE_MODELS_BUCKET, prefix)) ?? []) as BucketObject[];
  }

  /** The prefix's top-level `config.json`, parsed — `null` when absent, oversized or not JSON. */
  private async readConfig(prefix: string, files: LocalModelFile[]): Promise<Record<string, unknown> | null> {
    const entry = files.find((f) => f.key === LOCAL_CONFIG_OBJECT);
    if (!entry || entry.size > MAX_CONFIG_BYTES) return null;
    try {
      const parsed: unknown = JSON.parse((await this.bucket.getFile(HOPE_MODELS_BUCKET, `${prefix}${LOCAL_CONFIG_OBJECT}`)).toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch (error) {
      this.logger.warn({
        message: 'ai_model.local_preview.config_unreadable',
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
