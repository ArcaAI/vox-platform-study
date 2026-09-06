import { Injectable, BadRequestException, ForbiddenException, Inject, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelEntity,
  AiModelFactory,
  AiModelRepository,
  AiTaskKind,
  CoreDatabaseService,
  ModelTaskType,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantRepository,
} from '@arcaai/domains';
import { IAiModelService } from './IAiModelService';
import {
  CatalogueModelResponse,
  CatalogueProviderResponse,
  CreateModelRequest,
  ModelCatalogueFilter,
  ModelCatalogueResponse,
  ModelReadiness,
  ModelResponse,
  PaginatedModelResponse,
  SetPlatformDefaultRequest,
  UpdateModelRequest,
} from './dto';
import { AiModelDtoMapper } from './aiModel.dto.mapper';
import { toCatalogueModel } from './model-catalogue.mapper';
import { IInferenceReadinessService, type IInferenceReadinessServicePort } from './model-readiness.port';
import {
  MODEL_TASK_TYPE_SERVICE,
  PROVIDER_GROUP_HOPE,
  isCloudByoProvider,
  providerClassOf,
  type ProviderClass,
  type ProviderService,
} from '../ai-provider-connection/constants';
import { IProviderConnectionService, type IProviderConnectionService as IProviderConnectionServicePort } from '../ai-provider-connection/IProviderConnectionService';
import { modelAllowedForTier, modelTierForPlan } from '../entitlements/model-access';
import type { ModelTier } from '../entitlements/entitlements.constants';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

/** One `(service, provider)` pair's connection facts, resolved once per catalogue read. */
interface ConnectionFacts {
  tenantRow: { id: string; enabled: boolean; hasKey: boolean } | null;
  systemRow: { id: string; enabled: boolean; hasKey: boolean } | null;
  /** The CASCADE's answer — tenant row, else SYSTEM row, `null` on veto / entitlement denial. */
  resolved: { source: 'tenant' | 'system'; hasKey: boolean } | null;
}

/** A usability verdict plus the stable machine token explaining a refusal. */
interface Usability {
  usable: boolean;
  reason: string | null;
}

const USABLE: Usability = { usable: true, reason: null };

/** The picker id of ONE tenant BYO connection. `hope` is the only other group. */
function byoProviderId(service: ProviderService | null, provider: string | null | undefined): string {
  return `byo:${service ?? 'unknown'}:${provider ?? 'unknown'}`;
}

/**
 * Whether a connection row actually CARRIES key material. The "resolves but
 * never delivers" split: an ENABLED but KEYLESS row is an incomplete setup, not
 * a working credential, and a picker that called it usable would send the author
 * to a 503 at run time.
 */
function hasKeyMaterial(ciphertext: Uint8Array | null | undefined): boolean {
  return ciphertext !== null && ciphertext !== undefined && ciphertext.length > 0;
}

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
 * ## Derived, never stored
 *
 * `localPath` is `/mnt/models-bucket/` + `bucketPrefix`, plus `primaryObject`
 * for a single-file loader. The DTOs do not accept it and, since TASK-890
 * §3.11, nothing WRITES it either: the column is dropped and every reader
 * derives the value from the bucket identity (`derivedLocalPath`). The Python
 * resolvers still receive `local_path` on the wire, unchanged.
 */
@Injectable()
export class AiModelService extends BaseService implements IAiModelService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    // The UNSCOPED base client backs the SYSTEM write lane (see the class doc).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-890 — the tenant CATALOGUE's three collaborators, all `@Optional()`
    // and TRAILING so every existing positional unit fixture keeps its arity.
    // Production DI supplies the first two; the third lands with L12 and the
    // catalogue reports `unknown` readiness until it does.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionServicePort,
    @Optional() private readonly tenantRepository?: TenantRepository,
    @Optional() @Inject(IInferenceReadinessService) private readonly readiness?: IInferenceReadinessServicePort,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  /**
   * The TENANT-facing catalogue read (TASK-890 §3.7).
   *
   * A READ, not an admin surface: no `assertPlatformAdmin`. It answers the one
   * question an author has when binding a model — "what may I pick, and will it
   * work" — in two groups: the tenant's OWN provider connections first, then the
   * single "Hope provider" standing for everything the platform serves (OD-A,
   * OD-L).
   *
   * Three properties this method must keep:
   *
   *  1. **It never probes.** Readiness is joined from the stored snapshot
   *     (§3.12); a tenant reading its picker must not cause a vendor call.
   *  2. **Entitlements BOUND, they never supply.** The plan tier removes rows
   *     from the Hope group; it never adds one and never substitutes another.
   *  3. **`hope` is a DTO label.** `AiModel.provider` keeps the engine/vendor id
   *     that routing and the usage ledger are keyed on.
   */
  async getCatalogue(filter: ModelCatalogueFilter = {}): Promise<ModelCatalogueResponse> {
    const tenantId = this.tenantId ?? SYSTEM_TENANT_ID;
    const superAdmin = isSuperAdmin(this.requestUser);

    const rows = await this.aiModelRepository.findAll({
      filters: {
        resourceStatus: ResourceStatusType.ENABLED,
        ...(filter.taskType ? { taskType: filter.taskType } : {}),
        // NO tenant pin: `AiModel` is a SYSTEM-shared read model, so the
        // extension widens this to `tenantId IN [caller, SYSTEM]` — which is
        // exactly the two groups this catalogue has.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      } as any,
      sort: [{ name: 'asc' }],
    });

    const tier = await this.modelTierFor(tenantId);
    const snapshot = this.readiness ? await this.readiness.getSnapshot() : null;
    const facts = new Map<string, ConnectionFacts>();

    const classified: Array<{ entity: AiModelEntity; service: ProviderService | null; providerClass: ProviderClass; providerId: string }> = [];
    let unassignedProviderCount = 0;

    for (const entity of rows) {
      const service = MODEL_TASK_TYPE_SERVICE[entity.taskType] ?? null;
      const providerClass = providerClassOf(service, entity.provider, entity);
      if (!providerClass) {
        // Risk 6 — a row naming no provider this platform can serve. Hidden from
        // everyone; COUNTED for the super admin who can assign one.
        unassignedProviderCount += 1;
        continue;
      }
      // A row belonging to neither tier cannot appear (the extension already
      // guarantees it); the check is here so a future widening cannot leak one.
      if (entity.tenantId !== SYSTEM_TENANT_ID && entity.tenantId !== tenantId) continue;
      // Entitlements BOUND the Hope group. A tenant's OWN row is its own
      // account's model — a plan tier never hides what the tenant already pays
      // a vendor for.
      if (entity.tenantId === SYSTEM_TENANT_ID && !modelAllowedForTier(entity.tags, tier)) continue;

      const providerId = providerClass === 'cloud-byo' ? byoProviderId(service, entity.provider) : PROVIDER_GROUP_HOPE;
      classified.push({ entity, service, providerClass, providerId });
    }

    const models: CatalogueModelResponse[] = [];
    for (const { entity, service, providerClass, providerId } of classified) {
      const usability = await this.usabilityOf(providerClass, service, entity, tenantId, facts);
      const observation = snapshot?.models[entity.id];
      models.push(
        toCatalogueModel(entity, {
          providerId,
          providerClass,
          readiness: (observation?.readiness ?? 'unknown') as ModelReadiness,
          // A model the snapshot does not name is `unknown` as of NOW, not stale
          // as of the sweep — so it carries no timestamp at all.
          readinessCheckedAt: observation ? (snapshot?.checkedAt ?? null) : null,
          readinessDetail: observation?.detail ?? null,
          usable: usability.usable,
          unusableReason: usability.reason,
        }),
      );
    }

    const visible = filter.usableOnly ? models.filter((m) => m.usable) : models;
    const providers = await this.catalogueProviders(visible, classified, tenantId, facts);
    const scoped = filter.providerGroup ? providers.filter((p) => p.group === filter.providerGroup) : providers;
    const scopedIds = new Set(scoped.map((p) => p.id));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { catalogue: true, providerCount: scoped.length, modelCount: visible.length },
    });

    return {
      providers: scoped,
      models: visible.filter((m) => scopedIds.has(m.providerId)),
      ...(superAdmin ? { unassignedProviderCount } : {}),
    };
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

    // The bucket IDENTITY is the only thing stored; `localPath` is derived from
    // it on every read (TASK-890 §3.11). Clearing the prefix therefore clears the
    // path everywhere at once, and scheme dispatch on `sourceUri` resumes in the
    // resolvers — the same behaviour, with nothing to keep in step.
    if (dto.bucketPrefix !== undefined) existing.bucketPrefix = dto.bucketPrefix || null;
    if (dto.primaryObject !== undefined) existing.primaryObject = dto.primaryObject || null;

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
   * The model tier the caller's PLAN grants (`base` / `full` / `full_custom`).
   * SYSTEM — and any caller whose tenant cannot be read — gets the full
   * catalogue: the tier BOUNDS a tenant's choice, so an unresolvable plan must
   * never silently narrow the platform's own view.
   */
  private async modelTierFor(tenantId: string): Promise<ModelTier> {
    if (tenantId === SYSTEM_TENANT_ID || !this.tenantRepository) return modelTierForPlan(null);
    const tenant = await this.tenantRepository.findById(tenantId).catch(() => null);
    return modelTierForPlan(tenant?.plan ?? null);
  }

  /**
   * The `(service, provider)` connection facts, resolved ONCE per catalogue read.
   *
   * Three reads, because three different questions are being asked and no single
   * call answers them: the tenant's own row (does it exist, is it a VETO, is it
   * keyed), the SYSTEM row (does a platform credential exist at all), and the
   * CASCADE (`resolveConnection`, which is the one place the veto and the
   * `featurePlatformDefaultCredential` gate are applied — this method must never
   * re-implement either).
   */
  private async connectionFacts(
    service: ProviderService,
    provider: string,
    tenantId: string,
    cache: Map<string, ConnectionFacts>,
  ): Promise<ConnectionFacts> {
    const key = `${service}|${provider}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const port = this.providerConnections!;
    const [tenantRow, systemRow, resolved] = await Promise.all([
      port.findRow(service, provider, tenantId).catch(() => null),
      tenantId === SYSTEM_TENANT_ID ? Promise.resolve(null) : port.findRow(service, provider, SYSTEM_TENANT_ID).catch(() => null),
      port.resolveConnection(service, provider, tenantId).catch(() => null),
    ]);

    const facts: ConnectionFacts = {
      tenantRow: tenantRow ? { id: tenantRow.id, enabled: tenantRow.enabled, hasKey: hasKeyMaterial(tenantRow.encryptedApiKey) } : null,
      systemRow: systemRow ? { id: systemRow.id, enabled: systemRow.enabled, hasKey: hasKeyMaterial(systemRow.encryptedApiKey) } : null,
      resolved: resolved ? { source: resolved.source, hasKey: hasKeyMaterial(resolved.encryptedApiKey) } : null,
    };
    cache.set(key, facts);
    return facts;
  }

  /**
   * Whether an agent bound to this row could publish and RUN today (§3.7 class
   * table). Advisory readiness is a separate axis: an engine that is down now
   * may be up when the graph runs, and only `usable` blocks.
   */
  private async usabilityOf(
    providerClass: ProviderClass,
    service: ProviderService | null,
    entity: AiModelEntity,
    tenantId: string,
    cache: Map<string, ConnectionFacts>,
  ): Promise<Usability> {
    // The MEASURED column, never `localPath` (§3.11): the platform's own
    // services load these weights from the bucket, so presence IS usability.
    if (providerClass === 'platform-self-host') {
      return entity.availability === AiModelAvailability.AVAILABLE ? USABLE : { usable: false, reason: 'weights-not-available' };
    }

    // Every other class needs the connection plane. Absent collaborator ⇒ fail
    // CLOSED with a named cause, never an optimistic `true`.
    if (!this.providerConnections || !service || !entity.provider) {
      return { usable: false, reason: 'connection-resolver-unavailable' };
    }

    const facts = await this.connectionFacts(service, entity.provider, tenantId, cache);

    if (providerClass === 'cloud-byo') {
      if (!facts.tenantRow) return { usable: false, reason: 'no-enabled-connection' };
      if (!facts.tenantRow.enabled) return { usable: false, reason: 'no-enabled-connection' };
      return facts.tenantRow.hasKey ? USABLE : { usable: false, reason: 'credential-missing' };
    }

    if (providerClass === 'engine-served') {
      // A platform engine has no credential to bring: ENABLED is the whole test.
      return facts.resolved ? USABLE : { usable: false, reason: 'no-enabled-connection' };
    }

    // cloud-platform — the cascade decided; this only NAMES the outcome.
    if (facts.resolved?.hasKey) return USABLE;
    if (facts.tenantRow && !facts.tenantRow.enabled) return { usable: false, reason: 'no-enabled-connection' };
    if (facts.resolved) return { usable: false, reason: 'credential-missing' };
    // A keyed, ENABLED SYSTEM row that the cascade still refused can only mean
    // the platform-default entitlement is not granted — a different fix from
    // "nobody configured this provider", so it gets a different token.
    if (facts.systemRow?.enabled && facts.systemRow.hasKey) return { usable: false, reason: 'platform-credential-not-entitled' };
    return { usable: false, reason: 'no-enabled-connection' };
  }

  /**
   * The picker's GROUP entries: every ENABLED tenant connection that could carry
   * models (so a freshly-configured connection with nothing declared yet is
   * visible and actionable), any provider the tenant's own rows name, and then
   * the single Hope entry.
   */
  private async catalogueProviders(
    visibleModels: CatalogueModelResponse[],
    classified: Array<{ entity: AiModelEntity; service: ProviderService | null; providerClass: ProviderClass; providerId: string }>,
    tenantId: string,
    cache: Map<string, ConnectionFacts>,
  ): Promise<CatalogueProviderResponse[]> {
    const countByProviderId = new Map<string, number>();
    for (const model of visibleModels) countByProviderId.set(model.providerId, (countByProviderId.get(model.providerId) ?? 0) + 1);

    const byo = new Map<string, CatalogueProviderResponse>();

    // (a) the tenant's own ENABLED connections, per service in scope.
    if (this.providerConnections && tenantId !== SYSTEM_TENANT_ID) {
      const services = new Set<ProviderService>();
      for (const { service } of classified) if (service) services.add(service);
      for (const service of services) {
        const rows = await this.providerConnections.list(service, tenantId).catch(() => []);
        for (const row of rows) {
          if (!row.enabled || !isCloudByoProvider(service, row.provider)) continue;
          const id = byoProviderId(service, row.provider);
          const facts = await this.connectionFacts(service, row.provider, tenantId, cache);
          byo.set(id, {
            id,
            group: 'byo',
            name: row.provider,
            providerClass: 'cloud-byo',
            connectionId: facts.tenantRow?.id ?? null,
            usable: row.hasKey,
            reason: row.hasKey ? null : 'credential-missing',
            modelCount: countByProviderId.get(id) ?? 0,
          });
        }
      }
    }

    // (b) any provider the tenant's OWN rows name that (a) did not produce — a
    // connection that was disabled or deleted under its models. The models stay
    // listed and unusable rather than vanishing without explanation.
    for (const { entity, service, providerClass, providerId } of classified) {
      if (providerClass !== 'cloud-byo' || byo.has(providerId)) continue;
      const facts = service && entity.provider ? await this.connectionFacts(service, entity.provider, tenantId, cache) : null;
      byo.set(providerId, {
        id: providerId,
        group: 'byo',
        name: entity.provider ?? providerId,
        providerClass: 'cloud-byo',
        connectionId: facts?.tenantRow?.id ?? null,
        usable: false,
        reason: 'no-enabled-connection',
        modelCount: countByProviderId.get(providerId) ?? 0,
      });
    }

    const hopeCount = countByProviderId.get(PROVIDER_GROUP_HOPE) ?? 0;
    const hopeUsable = visibleModels.some((m) => m.providerId === PROVIDER_GROUP_HOPE && m.usable);
    const hope: CatalogueProviderResponse = {
      id: PROVIDER_GROUP_HOPE,
      group: PROVIDER_GROUP_HOPE,
      name: 'Hope provider',
      // The GROUP has no class; each of its models carries its own.
      providerClass: null,
      connectionId: null,
      usable: hopeUsable,
      reason: hopeUsable ? null : 'no-usable-model',
      modelCount: hopeCount,
    };

    // BYO first (OD-A picker order), then the single Hope entry.
    return [...[...byo.values()].sort((a, b) => a.id.localeCompare(b.id)), hope];
  }

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
