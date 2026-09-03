import { Injectable, BadRequestException, ForbiddenException, Inject, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AiDeploymentKind,
  AiModelEntity,
  AiModelFactory,
  AiModelRepository,
  AiModelDownloadStatus,
  AiTaskKind,
  CoreDatabaseService,
  ModelTaskType,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { IAiModelService } from './IAiModelService';
import { CreateModelRequest, UpdateModelRequest, ModelResponse, PaginatedModelResponse, SetPlatformDefaultRequest } from './dto';
import { AiModelDtoMapper } from './aiModel.dto.mapper';
import { deriveLocalPath } from './constants';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

/**
 * The model registry — ONE catalogue, SYSTEM-owned (TASK-860 R-1).
 *
 * ## Ownership
 *
 * Every write pins `tenantId = SYSTEM_TENANT_ID` and refuses a caller who is
 * not a platform (super) admin with `403` — a privilege boundary on a resource
 * the caller can already READ, so deliberately NOT the 404-over-403
 * cross-tenant posture. Reads are the SYSTEM catalogue: tenants reach it
 * through the tenant-scope extension's shared-read widening
 * (`SYSTEM_SHARED_READ_MODELS`) and never hold their own copies.
 *
 * ## The write lane
 *
 * A super admin's WORKING tenant W is elevated into CLS by the BFF proxy, and
 * the tenant-scope extension enforces W on every `create`/`update` through the
 * extended client (`enforceTenantInData` throws on a `tenantId` mismatch, the
 * CAS `updateMany` matches 0 rows). Registry writes therefore go through the
 * UNSCOPED base client — the same `crossTenantLane` shape
 * `AiTaskDefaultService` and `RbacRoleService` already use — and carry the
 * explicit SYSTEM filters themselves. Reads stay on the extended client: an
 * explicit `tenantId = SYSTEM` filter is exactly what the shared-read merge
 * admits.
 *
 * ## Derived, never typed
 *
 * `localPath` is `/mnt/models-bucket/` + `bucketPrefix` [+ `primaryObject`]
 * (D-2). The DTOs do not accept it; this service writes it whenever the bucket
 * identity changes so the Python resolvers — which still read `localPath` as
 * the highest-precedence override — keep working unchanged.
 */
@Injectable()
export class AiModelService extends BaseService implements IAiModelService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    // The UNSCOPED base client backs the SYSTEM write lane (see the class doc).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * Register a catalogue row. SYSTEM tenant, super admin only.
   */
  async create(dto: CreateModelRequest): Promise<ModelResponse> {
    this.assertPlatformAdmin();
    const userId = this.requestUserId;
    const tx = this.writeLane();

    if (dto.deploymentKind === AiDeploymentKind.CLOUD && !dto.wireModelId?.trim()) {
      throw new BadRequestException('A CLOUD model requires a wireModelId');
    }

    // Slug uniqueness is a SYSTEM-catalogue invariant now, not a per-tenant one.
    const existing = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, dto.slug, tx);
    if (existing) {
      throw new BadRequestException(`Model with slug '${dto.slug}' already exists`);
    }

    const model = AiModelFactory.CreateAiModel({
      tenantId: SYSTEM_TENANT_ID,
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
      libraryName: dto.libraryName,
      servedBy: dto.servedBy,
      deploymentKind: dto.deploymentKind,
      wireModelId: dto.wireModelId,
      license: dto.license,
      gated: dto.gated,
      baseModel: dto.baseModel,
      languages: dto.languages,
      hfRevision: dto.hfRevision,
      bucketPrefix: dto.bucketPrefix,
      primaryObject: dto.primaryObject,
      isPlatformDefaultFor: dto.isPlatformDefaultFor,
      provider: dto.provider,
      architecture: dto.architecture,
      memorySizeMb: dto.memorySizeMb,
      computeType: dto.computeType,
      tags: dto.tags,
      createdBy: userId ?? undefined,
    });
    if (dto.bucketPrefix) {
      model.localPath = deriveLocalPath(dto.bucketPrefix, dto.primaryObject);
    }
    model.validate();

    const saved = await this.aiModelRepository.create(model, tx);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: dto.slug, name: dto.name, taskType: dto.taskType, libraryName: dto.libraryName, servedBy: dto.servedBy },
    });

    return AiModelDtoMapper.toResponse(saved);
  }

  /**
   * Update a catalogue row (super admin only).
   *
   * OCC: writes via Compare-And-Set against the row's `_version` column
   * (mirrors `PipelineService.update`). The DTO's `expectedVersion` (or the
   * controller's `If-Match`-folded value) is the CAS predicate; on version
   * drift the repository raises `OptimisticConcurrencyException`, which the
   * `ExceptionInterceptor` maps to `412 Precondition Failed`.
   */
  async update(id: string, dto: UpdateModelRequest): Promise<ModelResponse> {
    this.assertPlatformAdmin();
    const userId = this.requestUserId;
    const tx = this.writeLane();

    const existing = await this.findRegistryRow(id);

    if (dto.slug && dto.slug !== existing.slug) {
      const taken = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, dto.slug, tx);
      if (taken && taken.id !== id) {
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
    if (dto.libraryName !== undefined) existing.libraryName = dto.libraryName;
    if (dto.servedBy !== undefined) existing.servedBy = dto.servedBy;
    if (dto.deploymentKind !== undefined) existing.deploymentKind = dto.deploymentKind;
    // Empty string clears the nullable card/wire fields (PATCH cannot carry null through the pipe).
    if (dto.wireModelId !== undefined) existing.wireModelId = dto.wireModelId || null;
    if (dto.license !== undefined) existing.license = dto.license || null;
    if (dto.gated !== undefined) existing.gated = dto.gated;
    if (dto.baseModel !== undefined) existing.baseModel = dto.baseModel || null;
    if (dto.languages !== undefined) existing.languages = dto.languages;
    if (dto.hfRevision !== undefined) existing.hfRevision = dto.hfRevision || null;
    if (dto.provider !== undefined) existing.provider = dto.provider;
    if (dto.architecture !== undefined) existing.architecture = dto.architecture;
    if (dto.memorySizeMb !== undefined) existing.memorySizeMb = dto.memorySizeMb;
    if (dto.computeType !== undefined) existing.computeType = dto.computeType;
    if (dto.checksum !== undefined) existing.checksum = dto.checksum;
    if (dto.tags !== undefined) existing.tags = dto.tags;

    // Bucket identity → derived localPath (D-2). Clearing the prefix clears
    // the path so scheme dispatch on `sourceUri` resumes in the resolvers.
    if (dto.bucketPrefix !== undefined || dto.primaryObject !== undefined) {
      if (dto.bucketPrefix !== undefined) existing.bucketPrefix = dto.bucketPrefix || null;
      if (dto.primaryObject !== undefined) existing.primaryObject = dto.primaryObject || null;
      existing.localPath = existing.bucketPrefix ? deriveLocalPath(existing.bucketPrefix, existing.primaryObject) : null;
    }

    existing.updatedBy = userId ?? null;
    existing.validate();

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors PipelineService.update).
    const previousVersion = existing.version;

    const updated = await this.aiModelRepository.updateWithVersion(id, existing, dto.expectedVersion, tx);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { slug: updated.slug, name: updated.name, previousVersion, newVersion: updated.version },
    });

    return AiModelDtoMapper.toResponse(updated);
  }

  /**
   * Platform-default election (super admin only). Each task in `dto.tasks` is
   * cleared from whichever ENABLED row held it, then written onto this row —
   * a task never has two defaults. Only an ENABLED row may be elected.
   */
  async setPlatformDefaultFor(id: string, dto: SetPlatformDefaultRequest): Promise<ModelResponse> {
    this.assertPlatformAdmin();
    const userId = this.requestUserId;
    const tx = this.writeLane();

    const target = await this.findRegistryRow(id);
    const tasks = [...new Set(dto.tasks)];
    if (tasks.length > 0 && target.resourceStatus !== ResourceStatusType.ENABLED) {
      throw new BadRequestException(`Model '${target.slug}' must be ENABLED to be a platform default`);
    }

    for (const task of tasks) {
      const holders = await this.aiModelRepository.findPlatformDefaultsFor(SYSTEM_TENANT_ID, task, tx);
      for (const holder of holders) {
        if (holder.id === target.id) continue;
        holder.setPlatformDefaultFor(
          (holder.isPlatformDefaultFor ?? []).filter((kind: AiTaskKind) => kind !== task),
          userId ?? undefined,
        );
        const cleared = await this.aiModelRepository.updateWithVersion(holder.id, holder, holder.version, tx);
        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
          resourceId: cleared.id,
          data: { slug: cleared.slug, platformDefaultFor: cleared.isPlatformDefaultFor, clearedTask: task },
        });
      }
    }

    target.setPlatformDefaultFor(tasks, userId ?? undefined);
    const updated = await this.aiModelRepository.updateWithVersion(target.id, target, target.version, tx);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { slug: updated.slug, platformDefaultFor: updated.isPlatformDefaultFor },
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
   * Get model by slug — the SYSTEM catalogue.
   */
  async getBySlug(slug: string): Promise<ModelResponse | null> {
    const model = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug);
    if (!model) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: model.id,
    });

    return AiModelDtoMapper.toResponse(model);
  }

  /**
   * Get all enabled catalogue rows.
   */
  async getAll(): Promise<ModelResponse[]> {
    const models = await this.aiModelRepository.findEnabledModels(SYSTEM_TENANT_ID);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: models.length },
    });

    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get all catalogue rows for the admin surface (ENABLED + DISABLED), so a
   * just-disabled model stays visible and re-enableable. Pinned to the SYSTEM
   * tenant explicitly: the tenant-scope extension's shared-read merge admits
   * exactly that filter whatever working tenant the caller has selected.
   */
  async getAllForAdmin(): Promise<ModelResponse[]> {
    const models = await this.aiModelRepository.findAll({
      filters: {
        tenantId: SYSTEM_TENANT_ID,
        resourceStatus: { in: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      } as any,
      sort: [{ name: 'asc' }],
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: models.length },
    });

    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get paginated list of catalogue rows
   */
  async list(page: number = 1, limit: number = 20): Promise<PaginatedModelResponse> {
    const models = await this.aiModelRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      filters: { tenantId: SYSTEM_TENANT_ID } as any,
      page,
      limit,
      sort: [{ name: 'asc' }],
    });

    const total = await this.aiModelRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      filters: { tenantId: SYSTEM_TENANT_ID } as any,
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
   * Get ENABLED catalogue rows by task type
   */
  async getByTaskType(taskType: ModelTaskType): Promise<ModelResponse[]> {
    const models = await this.aiModelRepository.findByTaskType(SYSTEM_TENANT_ID, taskType);
    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * Get ENABLED models by task type across [caller tenant, SYSTEM] — the
   * registry-picker read. Queries WITHOUT a tenant pin (the extension widens
   * the read to `tenantId IN [caller, SYSTEM]`), then de-duplicates by slug
   * preferring the caller-tenant row. With NO CLS tenant at all it pins
   * explicitly to the SYSTEM catalogue. Tenant clones are retired (TASK-860),
   * so this is the SYSTEM catalogue in practice; the widening is kept so a
   * row an older environment still carries resolves the way it always did.
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
   * @deprecated TASK-860 — removed in R3. Use `availability`.
   */
  async getDownloadedModels(): Promise<ModelResponse[]> {
    const models = await this.aiModelRepository.findDownloadedModels(SYSTEM_TENANT_ID);
    return models.map(AiModelDtoMapper.toResponse);
  }

  /**
   * @deprecated TASK-860 — removed in R3. The publish processor writes the row
   * back itself (`AiModelEntity.recordPublish`); kept for the transition.
   */
  async updateDownloadStatus(
    id: string,
    status: AiModelDownloadStatus,
    localPath?: string,
    fileSizeMb?: number,
    checksum?: string,
  ): Promise<ModelResponse> {
    this.assertPlatformAdmin();
    const userId = this.requestUserId;
    const tx = this.writeLane();

    const existing = await this.findRegistryRow(id);

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

    const updated = await this.aiModelRepository.update(id, existing, tx);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { downloadStatus: status },
    });

    return AiModelDtoMapper.toResponse(updated);
  }

  /**
   * Retire (soft delete) a catalogue row — super admin only.
   */
  async delete(id: string): Promise<void> {
    this.assertPlatformAdmin();
    const userId = this.requestUserId;
    const tx = this.writeLane();

    const existing = await this.findRegistryRow(id);

    existing.delete(userId ?? undefined);
    await this.aiModelRepository.update(id, existing, tx);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { slug: existing.slug },
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * The registry is a SUPER_ADMIN plane. A 403 (privilege), not a 404 — the
   * caller can already read the row it is trying to write.
   */
  private assertPlatformAdmin(): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('The model registry is managed by platform administrators only.');
    }
  }

  /**
   * The UNSCOPED base client for SYSTEM writes — see the class doc. Only ever
   * reached AFTER `assertPlatformAdmin`, so the lane is never open to a tenant
   * admin. When CLS already carries the SYSTEM tenant the extended client
   * would work too; using the lane unconditionally keeps one write path.
   */
  private writeLane(): CoreDatabaseService['baseClient'] {
    return this.databaseService.baseClient;
  }

  /** A registry row by id, or 404. Reads stay on the extended client (shared-read widening). */
  private async findRegistryRow(id: string): Promise<AiModelEntity> {
    const existing = await this.aiModelRepository.findById(id);
    if (!existing || existing.tenantId !== SYSTEM_TENANT_ID) {
      throw new NotFoundException(`Model ${id} not found`);
    }
    return existing;
  }
}
