import {
  AsrPipelineFactory,
  AsrPipelineRepository,
  AsrPipelineVersionFactory,
  AsrPipelineVersionRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { parse } from 'yaml';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IPipelineService } from './IPipelineService';
import { ClonePipelineRequest, CreatePipelineRequest, PaginatedPipelineResponse, PipelineResponse, PipelineVersionResponse, UpdatePipelineRequest } from './dto';
import { PipelineDtoMapper } from './pipeline.dto.mapper';

/**
 * The single source of the locked-copy refusal text. The console
 * surfaces it verbatim as the disabled-control reason (rule 11 §5), and the
 * e2e/unit suites assert it, so it must not drift between call sites.
 */
export const TEMPLATE_LOCKED_MESSAGE = 'Template copies are read-only — clone to customize';

@Injectable()
export class PipelineService extends BaseService implements IPipelineService {
  constructor(
    private readonly pipelineRepository: AsrPipelineRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Version snapshots written on config-YAML changes.
    private readonly versionRepository: AsrPipelineVersionRepository,
    // Optional (append-only DI); enforces the plan
    // `maxAsrPipelines` quota on create (kill-switch-gated, no-op when OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.AsrPipeline);
  }

  /**
   * Create a new ASR pipeline
   */
  async create(dto: CreatePipelineRequest): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Plan quota precheck (kill-switch-gated).
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.pipelineRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxAsrPipelines', currentCount);
    }

    // Check if slug already exists
    const isUnique = await this.pipelineRepository.isSlugUnique(tenantId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Pipeline with slug '${dto.slug}' already exists`);
    }

    // Validate YAML configuration
    const validation = await this.validateYaml(dto.configYaml);
    if (!validation.valid) {
      throw new BadRequestException(`Invalid pipeline configuration: ${validation.errors?.join(', ')}`);
    }

    const pipeline = AsrPipelineFactory.CreateAsrPipeline({
      tenantId,
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      configYaml: dto.configYaml,
      tags: dto.tags,
      createdBy: userId ?? undefined,
    });

    const saved = await this.pipelineRepository.create(pipeline);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: dto.slug, name: dto.name },
    });

    return PipelineDtoMapper.toResponse(saved);
  }

  /**
   * Update an existing pipeline.
   *
   * OCC migration. Writes via Compare-And-Set
   * against the row's `_version` column. The DTO's `expectedVersion` (or
   * the controller's `If-Match`-folded value) is the CAS predicate; on
   * version drift the repository raises `OptimisticConcurrencyException`,
   * which the `ExceptionInterceptor` maps to `412 Precondition Failed`.
   */
  async update(id: string, dto: UpdatePipelineRequest): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.pipelineRepository.findById(id);
    // Cross-tenant / missing both surface as 404 so we never leak existence.
    // `findById` resolves SYSTEM/foreign rows through the shared-read widening,
    // so existence alone is not an ownership proof — without this guard the
    // tenant-scoped write 0-matches and leaks as a 412 or a raw Prisma error.
    if (!existing || existing.tenantId !== tenantId) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    // Locked template copies are read-only for content.
    // Ordering is load-bearing: the ownership guard above runs FIRST, so a
    // cross-tenant probe gets 404 and never sees this 403 (which would confirm
    // the row exists). Same-tenant, though, the caller can already see this row
    // in their own list — there is no existence to hide, and answering 404
    // would be a lie that breaks the console UX. So we return an honest,
    // actionable 403, matching the same-tenant error precedents (OCC 412,
    // quota 409). `toggle`/`setDefault` are deliberately NOT guarded — a
    // tenant may always toggle or default an otherwise-locked pipeline.
    this.assertNotTemplateLocked(existing);

    if (dto.slug && dto.slug !== existing.slug) {
      const isUnique = await this.pipelineRepository.isSlugUnique(tenantId, dto.slug, id);
      if (!isUnique) {
        throw new BadRequestException(`Pipeline with slug '${dto.slug}' already exists`);
      }
    }

    if (dto.configYaml) {
      const validation = await this.validateYaml(dto.configYaml);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid pipeline configuration: ${validation.errors?.join(', ')}`);
      }
    }

    // Detect a config change BEFORE we mutate the entity, so we
    // can snapshot a version only when the YAML actually changed (name/slug/tag
    // edits don't create versions).
    const configChanged = dto.configYaml !== undefined && dto.configYaml !== existing.configYaml;

    if (dto.name !== undefined) existing.name = dto.name;
    if (dto.slug !== undefined) existing.slug = dto.slug;
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.configYaml !== undefined) existing.configYaml = dto.configYaml;
    if (dto.tags !== undefined) existing.tags = dto.tags;
    existing.updatedBy = userId ?? null;

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors C.8 / E.1 / E.2 / E.3).
    const previousVersion = existing.version;

    const updated = await this.pipelineRepository.updateWithVersion(id, existing, dto.expectedVersion);

    // After a successful CAS write, snapshot the new YAML config
    // as the next AsrPipelineVersion (monotonic versionNumber), capturing the
    // change reason + author. Only on actual config changes.
    if (configChanged) {
      await this.snapshotVersion(updated, dto.changeReason, userId ?? undefined);
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        slug: updated.slug,
        name: updated.name,
        previousVersion,
        newVersion: updated.version,
        configChanged,
      },
    });

    return PipelineDtoMapper.toResponse(updated);
  }

  /**
   * Reject content mutations on a locked template copy.
   *
   * Call ONLY after the caller's ownership of the row has been established, so
   * this 403 can never confirm the existence of another tenant's pipeline.
   */
  private assertNotTemplateLocked(pipeline: { templateLocked?: boolean }): void {
    if (pipeline.templateLocked) {
      throw new ForbiddenException(TEMPLATE_LOCKED_MESSAGE);
    }
  }

  /**
   * Clone a pipeline into a new, editable copy.
   *
   * This is the sanctioned way to customize a locked template copy: tenant
   * admins can clone/copy or create their own. The
   * clone is always UNLOCKED, and it inherits everything but its identity from
   * the source, including:
   *
   *  - `sourceTemplateSlug`, carried verbatim so provenance survives clone
   *    chains. A copy-of-a-copy still reports the template it ultimately came
   *    from; a clone of a wholly hand-made pipeline keeps `null`.
   *  - the source's CURRENT config, written as the clone's own v1 version
   *    snapshot so the copy starts with an honest version history rather than
   *    an empty one (mirrors `TenantService.provisionTenantPipelineCatalog`).
   *
   * The SOURCE is resolved through the tenant ownership guard, so a tenant
   * clones their OWN copy of a template — not the SYSTEM row directly (which
   * `findById` can see through the shared-read widening). Every tenant
   * already holds a copy of every template.
   */
  async clone(id: string, dto: ClonePipelineRequest): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const source = await this.pipelineRepository.findById(id);
    // Cross-tenant / missing both surface as 404 (see `update`).
    if (!source || source.tenantId !== tenantId) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    // A clone is a NEW row, so it consumes plan quota exactly like `create`.
    if (this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.pipelineRepository.count({ where: { tenantId } });
      await this.entitlements.assertQuantityQuota(tenantId, 'maxAsrPipelines', currentCount);
    }

    const isUnique = await this.pipelineRepository.isSlugUnique(tenantId, dto.slug);
    if (!isUnique) {
      throw new BadRequestException(`Pipeline with slug '${dto.slug}' already exists`);
    }

    // The source's CURRENT config: newest version snapshot if it has any,
    // otherwise the pipeline-level YAML (rows provisioned by the seed carry no
    // version history — `seedAsrPipelines` writes none).
    const sourceVersions = await this.versionRepository.findByPipeline(source.id);
    const currentConfigYaml = sourceVersions[0]?.configYaml ?? source.configYaml;

    const clone = AsrPipelineFactory.CreateAsrPipeline({
      tenantId,
      name: dto.name,
      slug: dto.slug,
      description: source.description ?? undefined,
      configYaml: currentConfigYaml,
      tags: source.tags,
      // The copy is the customizable one — never locked, whatever the source is.
      templateLocked: false,
      sourceTemplateSlug: source.sourceTemplateSlug ?? null,
      createdBy: userId ?? undefined,
    });

    const saved = await this.pipelineRepository.create(clone);

    await this.snapshotVersion(
      saved,
      `Cloned from pipeline '${source.slug}' (TASK-531)`,
      userId ?? undefined,
    );

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        slug: saved.slug,
        name: saved.name,
        clonedFrom: source.id,
        sourceTemplateSlug: saved.sourceTemplateSlug ?? null,
      },
    });

    return PipelineDtoMapper.toResponse(saved);
  }

  /**
   * Persist a config-YAML snapshot as the next AsrPipelineVersion.
   */
  private async snapshotVersion(pipeline: { id: string; name: string; description?: string | null; configYaml: string; tenantId?: string | null }, changeReason?: string, changedBy?: string): Promise<void> {
    const versionNumber = await this.versionRepository.getNextVersionNumber(pipeline.id);
    const version = AsrPipelineVersionFactory.CreateAsrPipelineVersion({
      asrPipelineId: pipeline.id,
      versionNumber,
      configYaml: pipeline.configYaml,
      name: pipeline.name,
      description: pipeline.description ?? null,
      changeReason: changeReason ?? null,
      changedBy: changedBy ?? null,
      tenantId: (pipeline.tenantId as string) ?? this.tenantId ?? '',
      createdBy: changedBy ?? undefined,
    });
    await this.versionRepository.create(version);
  }

  /**
   * Assign a pipeline within its owning tenant.
   *
   * The data model does not support a cross-tenant move: `AsrPipeline` has a
   * single `tenantId` whose entity setter is deliberately *protected*
   * (`BaseTenantEntity`), and the tenant-scope Prisma extension constrains
   * writes to the caller's tenant. We therefore reject a cross-tenant target
   * instead of faking a transfer, and persist the only meaningful same-tenant
   * assignment: promoting the pipeline to the tenant default (atomic flip via
   * `setDefault`).
   */
  async assignToTenant(id: string, targetTenantId: string): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    if (!targetTenantId || targetTenantId.trim().length === 0) {
      throw new BadRequestException('tenantId is required');
    }
    if (targetTenantId !== tenantId) {
      throw new BadRequestException(
        'Cross-tenant pipeline assignment is not supported; a pipeline can only be assigned within its owning tenant.',
      );
    }

    // Same-tenant assignment → persist by promoting the pipeline to the tenant
    // default (tenant-scoped 404 if the row is not owned by the caller).
    return this.setDefault(id);
  }

  /**
   * Mark a pipeline as the tenant default.
   *
   * Delegates the multi-row flip to the repository transaction
   * (`setDefaultForTenant`) so the "exactly one default per tenant"
   * invariant is enforced atomically. This is a tenant-scoped flag flip, not
   * a content edit, so it is intentionally NOT OCC/If-Match guarded.
   */
  async setDefault(id: string): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.pipelineRepository.findById(id);
    // Cross-tenant / missing both surface as 404 so we never leak existence.
    if (!existing || existing.tenantId !== tenantId) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    await this.pipelineRepository.setDefaultForTenant(tenantId, id, userId ?? undefined);

    const updated = await this.pipelineRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { isDefault: true, slug: existing.slug },
    });

    return PipelineDtoMapper.toResponse(updated ?? existing);
  }

  /**
   * Enable/disable a pipeline by flipping its resourceStatus.
   * OCC-guarded: `expectedVersion` (the controller's If-Match) is the CAS
   * predicate; drift raises OptimisticConcurrencyException → 412.
   */
  async toggle(id: string, enabled: boolean, expectedVersion?: number): Promise<PipelineResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const existing = await this.pipelineRepository.findById(id);
    if (!existing || existing.tenantId !== tenantId) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    if (enabled) {
      existing.enable(userId ?? undefined);
    } else {
      existing.disable(userId ?? undefined);
    }

    const previousVersion = existing.version;
    const updated = await this.pipelineRepository.updateWithVersion(id, existing, expectedVersion ?? existing.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        slug: updated.slug,
        resourceStatus: updated.resourceStatus,
        previousVersion,
        newVersion: updated.version,
      },
    });

    return PipelineDtoMapper.toResponse(updated);
  }

  /**
   * List config-version snapshots for a pipeline (newest first).
   * Tenant-scoped: a foreign/missing pipeline yields an empty list (no leak).
   */
  async listVersions(id: string): Promise<PipelineVersionResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findById(id);
    if (!pipeline || pipeline.tenantId !== tenantId) {
      return [];
    }

    const versions = await this.versionRepository.findByPipeline(id);
    return versions.map(PipelineDtoMapper.toVersionResponse);
  }

  /**
   * Fetch one config-version snapshot by version number.
   * Tenant-scoped; returns null when the pipeline or version is absent.
   */
  async getVersion(id: string, versionNumber: number): Promise<PipelineVersionResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findById(id);
    if (!pipeline || pipeline.tenantId !== tenantId) {
      return null;
    }

    const versions = await this.versionRepository.findByPipeline(id);
    const match = versions.find((v) => v.versionNumber === versionNumber);
    return match ? PipelineDtoMapper.toVersionResponse(match) : null;
  }

  /**
   * Get pipeline by ID — tenant-scoped.
   *
   * Returns `null` when:
   *   • The pipeline does not exist, OR
   *   • The pipeline belongs to a different tenant.
   *
   * The cross-tenant case returns `null` (NOT a 403) so the API surface
   * looks identical to "not found" — this prevents existence-leak via the
   * presence/absence of an authorization error.
   */
  async getById(id: string): Promise<PipelineResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findById(id);
    if (!pipeline) return null;

    if (pipeline.tenantId !== tenantId) {
      return null;
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: pipeline.id,
    });

    return PipelineDtoMapper.toResponse(pipeline);
  }

  /**
   * Get pipeline by slug
   */
  async getBySlug(slug: string): Promise<PipelineResponse | null> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipeline = await this.pipelineRepository.findBySlug(tenantId, slug);
    if (!pipeline) return null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: pipeline.id,
    });

    return PipelineDtoMapper.toResponse(pipeline);
  }

  /**
   * Get all enabled pipelines
   */
  async getAll(): Promise<PipelineResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelines = await this.pipelineRepository.findEnabledPipelines(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: pipelines.length },
    });

    return pipelines.map(PipelineDtoMapper.toResponse);
  }

  /**
   * Get all pipelines for the admin surface, regardless of enabled status.
   *
   * The enabled-only `getAll` (above) is shared with the public
   * end-user listing. The admin list, however, has a disable toggle and then
   * refetches, so an enabled-only query made a just-disabled pipeline vanish
   * with no way to re-enable it. The admin surface therefore reads
   * `findAllForAdmin` (ENABLED + DISABLED, excludes deleted) while the public
   * listing stays enabled-only.
   */
  async getAllForAdmin(): Promise<PipelineResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelines = await this.pipelineRepository.findAllForAdmin(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { count: pipelines.length },
    });

    return pipelines.map(PipelineDtoMapper.toResponse);
  }

  /**
   * Get paginated list of pipelines
   */
  async list(page: number = 1, limit: number = 20): Promise<PaginatedPipelineResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const pipelines = await this.pipelineRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
      page,
      limit,
      sort: [{ name: 'asc' }],
    });

    const total = await this.pipelineRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId } as any,
    });

    return {
      data: pipelines.map(PipelineDtoMapper.toResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Soft delete a pipeline
   */
  async delete(id: string): Promise<void> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    const existing = await this.pipelineRepository.findById(id);
    // Cross-tenant / missing both surface as 404 so we never leak existence
    // (see `update` — the same shared-read widening applies here).
    if (!existing || existing.tenantId !== tenantId) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }

    // Same guard order as `update`: ownership 404 first,
    // then the lock 403. Deleting a template copy would silently shrink the
    // tenant's catalog below the SYSTEM baseline; clone-and-delete-your-own is
    // the supported path.
    this.assertNotTemplateLocked(existing);

    // (soft-delete consistency): use the repository's dedicated
    // `softDelete` so the OCC version bump + DELETED status are applied the same
    // way as every other module. The prior `entity.delete()` + `update()` path
    // set the status but skipped the CAS version bump in `softDelete`, so a
    // concurrent delete could silently double-apply instead of failing OCC.
    await this.pipelineRepository.softDelete(id, userId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { slug: existing.slug },
    });
  }

  /**
   * Validate pipeline YAML configuration
   */
  async validateYaml(yaml: string): Promise<{ valid: boolean; errors?: string[] }> {
    // Fast local structural checks first (also the fallback verdict when the
    // STT service is unreachable).
    const local = this.validateYamlLocally(yaml);
    if (!local.valid) {
      return local;
    }

    // Authoritative validation proxied to stt, which runs
    // the SAME PipelineYamlParser the runtime uses (schema v2: provider::model
    // shorthand, stage toggles, engine/quantization/language rules). This
    // replaces hand-duplicating those rules in TypeScript; when the service
    // is unreachable the loose local verdict stands (create/update still
    // fail-fast at the Python runtime if a bad config slips through).
    const remote = await this.validateYamlRemotely(yaml);
    return remote ?? local;
  }

  private validateYamlLocally(yaml: string): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    try {
      // Basic YAML structure validation
      if (!yaml || yaml.trim().length === 0) {
        errors.push('YAML configuration is empty');
        return { valid: false, errors };
      }

      const parsed = parse(yaml);
      const root = this.asRecord(parsed);

      if (!root) {
        errors.push('YAML root must be a mapping/object');
        return { valid: false, errors };
      }

      const models = this.asRecord(root.models);
      if (!models) {
        errors.push('Missing required "models" section');
      } else if (!this.hasAsrModelReference(models.asr)) {
        errors.push('Missing required ASR model reference (models.asr)');
      }

      if (errors.length > 0) {
        return { valid: false, errors };
      }

      return { valid: true };
    } catch (error) {
      errors.push(`YAML parsing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { valid: false, errors };
    }
  }

  private async validateYamlRemotely(
    yaml: string,
  ): Promise<{ valid: boolean; errors?: string[] } | null> {
    try {
      // URL resolution mirrors serviceHealthMonitoring.service.ts; stt is
      // gateway-fronted and carries no service-token middleware.
      const base = process.env.STT_URL || process.env.STT_V2_URL || 'http://localhost:8861';
      const response = await fetch(`${base}/api/v1/pipelines/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_yaml: yaml }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        valid: boolean;
        errors?: { field: string; message: string }[];
      };
      if (body.valid) {
        return { valid: true };
      }
      return {
        valid: false,
        errors: (body.errors ?? []).map((e) => `${e.field}: ${e.message}`),
      };
    } catch {
      // Unreachable/timeout — the local verdict stands.
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private hasAsrModelReference(value: unknown): boolean {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    const asrConfig = this.asRecord(value);
    if (!asrConfig) {
      return false;
    }

    const referenceKeys = ['hf_model_id', 'model_id', 'slug', 'name', 'id'];
    return referenceKeys.some((key) => {
      const candidate = asrConfig[key];
      return typeof candidate === 'string' && candidate.trim().length > 0;
    });
  }
}
