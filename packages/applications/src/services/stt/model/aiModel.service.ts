import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AiModelEntity,
  AiModelFactory,
  AiModelRepository,
  AiModelDownloadStatus,
  ModelTaskType,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { IAiModelService } from './IAiModelService';
import { CreateModelRequest, UpdateModelRequest, ModelResponse, PaginatedModelResponse } from './dto';
import { AiModelDtoMapper } from './aiModel.dto.mapper';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

@Injectable()
export class AiModelService extends BaseService implements IAiModelService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * Create a new AI model
   */
  async create(dto: CreateModelRequest): Promise<ModelResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Check if slug already exists
    const isUnique = await this.aiModelRepository.isSlugUnique(tenantId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Model with slug '${dto.slug}' already exists`);
    }

    const model = AiModelFactory.CreateAiModel({
      tenantId,
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      category: dto.category,
      taskType: dto.taskType,
      modelType: dto.modelType,
      source: dto.source,
      sourceUri: dto.sourceUri,
      sourceRevision: dto.sourceRevision,
      format: dto.format,
      provider: dto.provider,
      architecture: dto.architecture,
      memorySizeMb: dto.memorySizeMb,
      computeType: dto.computeType,
      tags: dto.tags,
      createdBy: userId ?? undefined,
    });

    const saved = await this.aiModelRepository.create(model);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: dto.slug, name: dto.name, taskType: dto.taskType },
    });

    return AiModelDtoMapper.toResponse(saved);
  }

  /**
   * Update an existing model.
   *
   * OCC retrofit. Writes via Compare-And-Set against the
   * row's `_version` column (mirrors `PipelineService.update`). The DTO's
   * `expectedVersion` (or the controller's `If-Match`-folded value) is the CAS
   * predicate; on version drift the repository raises
   * `OptimisticConcurrencyException`, which the `ExceptionInterceptor` maps to
   * `412 Precondition Failed`.
   */
  async update(id: string, dto: UpdateModelRequest): Promise<ModelResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.aiModelRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    // Check slug uniqueness if changing
    if (dto.slug && dto.slug !== existing.slug) {
      const isUnique = await this.aiModelRepository.isSlugUnique(tenantId, dto.slug, id);
      if (!isUnique) {
        throw new BadRequestException(`Model with slug '${dto.slug}' already exists`);
      }
    }

    // Apply updates (expectedVersion is the CAS predicate, never an entity field).
    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.slug !== undefined) existing.slug = dto.slug;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.category !== undefined) existing.category = dto.category;
    if (dto.taskType !== undefined) existing.taskType = dto.taskType;
    if (dto.modelType !== undefined) existing.modelType = dto.modelType;
    if (dto.source !== undefined) existing.source = dto.source;
    if (dto.sourceUri !== undefined) existing.sourceUri = dto.sourceUri;
    if (dto.sourceRevision !== undefined) existing.sourceRevision = dto.sourceRevision;
    if (dto.format !== undefined) existing.format = dto.format;
    if (dto.provider !== undefined) existing.provider = dto.provider;
    if (dto.architecture !== undefined) existing.architecture = dto.architecture;
    if (dto.memorySizeMb !== undefined) existing.memorySizeMb = dto.memorySizeMb;
    if (dto.computeType !== undefined) existing.computeType = dto.computeType;
    // Operator weight override. Highest precedence in every
    // service's `resolve_model_dir`; an empty string clears it so that scheme
    // dispatch on `sourceUri` resumes.
    if (dto.localPath !== undefined) existing.localPath = dto.localPath;
    if (dto.checksum !== undefined) existing.checksum = dto.checksum;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    existing.updatedBy = userId ?? null;

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors PipelineService.update).
    const previousVersion = existing.version;

    const updated = await this.aiModelRepository.updateWithVersion(id, existing, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { slug: updated.slug, name: updated.name, previousVersion, newVersion: updated.version },
    });

    return AiModelDtoMapper.toResponse(updated);
  }

  /**
   * Get model by ID
   */
  async getById(id: string): Promise<ModelResponse | null> {
    const model = await this.aiModelRepository.findById(id);
    if (!model) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: model.id,
    });

    return AiModelDtoMapper.toResponse(model);
  }

  /**
   * Get model by slug
   */
  async getBySlug(slug: string): Promise<ModelResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const model = await this.aiModelRepository.findBySlug(tenantId, slug);
    if (!model) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: model.id,
    });

    return AiModelDtoMapper.toResponse(model);
  }

  /**
   * Get all enabled models
   */
  async getAll(): Promise<ModelResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const models = await this.aiModelRepository.findEnabledModels(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: models.length },
    });

    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get all models for the admin surface (ENABLED + DISABLED), scoped to the
   * EXACT caller tenant.
   *
   * Mirrors `PipelineService.getAllForAdmin` so a
   * just-disabled model stays visible and re-enableable. The explicit
   * `tenantId` filter pins the read to the caller's own rows: the tenant-scope
   * extension only widens to include the SYSTEM catalog when NO `tenantId` is
   * supplied (`tenant-scope.ts` `mergeSharedReadTenantIntoWhere`), so passing
   * it here keeps the SYSTEM master template out of the tenant admin grid — a
   * tenant admin manages only its own clone. The explicit `resourceStatus`
   * filter also suppresses the default soft-delete `{ not: DELETED }` rewrite
   * while still excluding deleted rows.
   */
  async getAllForAdmin(): Promise<ModelResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const models = await this.aiModelRepository.findAll({
      filters: {
        tenantId,
        resourceStatus: { in: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      sort: [{ name: 'asc' }],
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: models.length },
    });

    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get paginated list of models
   */
  async list(page: number = 1, limit: number = 20): Promise<PaginatedModelResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const models = await this.aiModelRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
      page,
      limit,
      sort: [{ name: 'asc' }],
    });

    const total = await this.aiModelRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
    });

    return {
      data: models.map(AiModelDtoMapper.toResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get models by task type
   */
  async getByTaskType(taskType: ModelTaskType): Promise<ModelResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const models = await this.aiModelRepository.findByTaskType(tenantId, taskType);
    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get ENABLED models by task type across [caller tenant, SYSTEM] — the
   * registry-picker read.
   *
   * The legacy `getByTaskType` pins `tenantId` to the CLS tenant, which
   * DEFEATS the tenant-scope extension's SYSTEM-shared-read widening: a
   * tenant without cloned rows sees an empty catalog. This variant queries
   * WITHOUT a tenant pin (the extension widens the read to
   * `tenantId IN [caller, SYSTEM]`), then de-duplicates by slug preferring
   * the caller-tenant row over its SYSTEM template. With NO CLS tenant at
   * all (a non-elevated global admin — the extension would pass the read
   * through unfiltered across ALL tenants), it pins explicitly to the
   * SYSTEM platform catalog instead. Legacy callers of `getByTaskType`
   * (exact-tenant semantics) are untouched.
   */
  async getByTaskTypeSharedRead(taskType: ModelTaskType): Promise<ModelResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      const systemModels = await this.aiModelRepository.findByTaskType(SYSTEM_TENANT_ID, taskType);
      return systemModels.map(AiModelDtoMapper.toResponse);
    }

    const rows = await this.aiModelRepository.findByTaskTypeSharedRead(taskType);
    const bySlug = new Map<string, AiModelEntity>();
    for (const row of rows) {
      const existing = bySlug.get(row.slug);
      if (!existing || (existing.tenantId !== tenantId && row.tenantId === tenantId)) {
        bySlug.set(row.slug, row);
      }
    }
    return [...bySlug.values()].map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get downloaded models
   */
  async getDownloadedModels(): Promise<ModelResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const models = await this.aiModelRepository.findDownloadedModels(tenantId);
    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Update model download status
   */
  async updateDownloadStatus(
    id: string,
    status: AiModelDownloadStatus,
    localPath?: string,
    fileSizeMb?: number,
    checksum?: string,
  ): Promise<ModelResponse> {
    const userId = this.requestUserId;

    const existing = await this.aiModelRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    switch (status) {
      case AiModelDownloadStatus.DOWNLOADING:
        existing.markAsDownloading(userId ?? undefined);
        break;
      case AiModelDownloadStatus.DOWNLOADED:
        if (!localPath) {
          throw new BadRequestException('Local path is required for DOWNLOADED status');
        }
        existing.markAsDownloaded(localPath, fileSizeMb, checksum, userId ?? undefined);
        break;
      case AiModelDownloadStatus.DOWNLOAD_FAILED:
        existing.markAsDownloadFailed(userId ?? undefined);
        break;
      case AiModelDownloadStatus.NOT_DOWNLOADED:
        existing.resetDownloadStatus(userId ?? undefined);
        break;
    }

    const updated = await this.aiModelRepository.update(id, existing);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { downloadStatus: status },
    });

    return AiModelDtoMapper.toResponse(updated);
  }

  /**
   * Soft delete a model
   */
  async delete(id: string): Promise<void> {
    const userId = this.requestUserId;

    const existing = await this.aiModelRepository.findById(id);
    if (!existing) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    existing.delete(userId ?? undefined);
    await this.aiModelRepository.update(id, existing);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { slug: existing.slug },
    });
  }
}
