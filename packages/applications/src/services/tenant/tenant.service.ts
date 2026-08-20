import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  SysEventType,
  EntityId,
  TenantEntity,
  TenantFactory,
  TenantRepository,
  GlobalSettingFactory,
  GlobalSettingRepository,
  GlobalSettingEntity,
  CoreDatabaseService,
  DepartmentRepository,
  DepartmentFactory,
  DepartmentEntity,
  PromptTemplateRepository,
  PromptTemplateFactory,
  PromptVersionRepository,
  PromptVersionFactory,
  DepartmentAgentRepository,
  DepartmentAgentFactory,
  AsrPipelineRepository,
  AsrPipelineFactory,
  AsrPipelineVersionRepository,
  AsrPipelineVersionFactory,
  AiModelRepository,
  AiModelFactory,
  TenantPlan,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { ITenantService } from './ITenantService';
import { CreateTenantRequest, UpdateTenantRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UpdateTenantConfigRequest } from './dto/updateTenantConfigRequest';
import { ITenantBucketService } from '../tenant-bucket/ITenantBucketService';
import { GLOBAL_TENANT_KEY, SUPER_ADMIN_ROLE, isUuidIdentifier } from './constants';
import { DEFAULT_GEN_DEPARTMENT } from './departmentDefaults';
import { scrubLockedForAudit } from './scrubbing';
import { generateUniqueTenantKey } from './tenantKey';
// Plan → model clone-subset. Imported from the specific file
// (not the entitlements barrel) to avoid pulling the request-scoped
// EntitlementsService and creating a module import cycle.
import { modelAllowedForTier, modelTierForPlan } from '../entitlements/model-access';

/**
 * Reserved system tenant that owns the platform-wide AI model catalog (the
 * master template cloned into every customer tenant). Declared
 * as a local literal rather than a cross-package import, mirroring the
 * precedent in `userPreferences.service.ts` and the duplicate literal in the
 * `tenant-scope` Prisma extension.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Model-aware filter coercion: coerces
 * stringly-typed CSV `filters` values to the Tenant columns' real types before
 * the `where` reaches Prisma (`version` → number, `trialEndsAt`/`createdAt` →
 * Date, `plan`/`resourceStatus` → member-validated enums, `metaData` →
 * JSON-path support). Passed to BOTH the data and count builders so they stay
 * in lock-step.
 */
const TENANT_FILTER_MODEL = 'Tenant';

/**
 * Service for managing tenants and their configurations
 * Implements the ITenantService interface
 */
@Injectable()
export class TenantService extends BaseService implements ITenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(
    private readonly tenantRepository: TenantRepository,
    private readonly globalSettingRepository: GlobalSettingRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly asrPipelineRepository: AsrPipelineRepository,
    @Inject('CORE_DATABASE_SERVICE')
    private readonly databaseService: CoreDatabaseService,
    @Inject(ITenantBucketService)
    private readonly tenantBucketService: ITenantBucketService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Appended last so existing positional callers
    // (and tests) stay append-only. Used to clone the SYSTEM AiModel catalog
    // into each new tenant.
    private readonly aiModelRepository: AiModelRepository,
    // Appended last (append-only). Used
    // to clone the SYSTEM default ASR pipeline's current version into each new
    // tenant alongside the pipeline itself.
    private readonly asrPipelineVersionRepository: AsrPipelineVersionRepository,
    // Appended last (append-only). Used by
    // `provisionTenantAgentCatalog` to write the tenant's DepartmentAgent
    // clones and their v1 PromptVersion snapshots when cloning the SYSTEM
    // golden agent library into each new tenant.
    private readonly departmentAgentRepository: DepartmentAgentRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
  }

  /**
   * Creates a new tenant
   * @param request - The tenant creation request containing tenant details
   * @returns Promise resolving to the created TenantEntity
   * @throws InternalServerErrorException if tenant creation fails
   */
  async create(request: CreateTenantRequest): Promise<TenantEntity> {
    // Auto-generate the key from `name` when the caller omits
    // it; an explicit `key` (super-admin override) is used as-is (already
    // format/reserved-validated by the DTO).
    const key = request.key ?? (await generateUniqueTenantKey(request.name, (candidate) => this.tenantKeyExists(candidate)));

    const newTenant = TenantFactory.CreateTenant({
      ...request,
      key,
      // New tenants default to STARTER (overridable via
      // `request.plan`). TRIAL
      // remains a selectable plan and keeps its 7-day PRO-entitled trial
      // clock in the factory. Enforcement ships OFF, so this is
      // display-only until the kill-switch is flipped per-env.
      plan: request.plan ?? TenantPlan.STARTER,
      createdBy: this.requestUser?.id,
    });

    const tenant = await this.tenantRepository.create(newTenant);

    if (!tenant) {
      throw new InternalServerErrorException(`Failed to create TenantEntity: ${request}`);
    }

    // Tenant creation is a cross-tenant, super-admin operation:
    // CLS `tenantId` is empty for the whole call (the new tenant isn't
    // "active" yet), so `broadcastSysEvent()`'s CLS-only attribution
    // (anti-spoofing) would stamp every provisioning event
    // below with `tenantId: null`. Rebind CLS to the tenant this call is
    // legitimately provisioning, request-scoped, before the first broadcast.
    this.clsService.set('tenantId', tenant.id);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: tenant.id,
      createdAt: tenant.createdAt,
      data: tenant.toObject() as object,
    });

    try {
      await this.tenantBucketService.provisionSystemBuckets(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision system storage buckets for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      // Write the plan's storageQuotaBytes onto the primary
      // system bucket now that buckets exist.
      await this.tenantBucketService.applyPlanStorageQuota(tenant.id, tenant.plan ?? null);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to apply plan storage quota for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.provisionTenantConfigs(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision tenant configurations for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.provisionDefaultDepartment(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision default department for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      // Clone only the plan-appropriate model subset.
      await this.provisionTenantModelCatalog(tenant.id, tenant.plan ?? null);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision AI model catalog for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.provisionTenantPipelineCatalog(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision ASR pipeline catalog for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.provisionTenantAgentCatalog(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision agent golden library for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return tenant;
  }

  /**
   * Clones every `AiModel` row from the master `SYSTEM_TENANT_ID` catalog into
   * the newly created tenant so each tenant owns an editable copy of the
   * platform catalog. Composes with the `GlobalSetting` clone
   * (`provisionTenantConfigs`) as an independent provisioning step.
   *
   * Behaviour mirrors `provisionTenantConfigs`:
   *  - Reads the SYSTEM-owned source rows.
   *  - For each source row, skips it when the new tenant already owns the slug
   *    (`isSlugUnique` === false) so the method is idempotent and safe to
   *    re-run as an existing-tenant backfill.
   *  - Builds a clone via `AiModelFactory` bound to the NEW tenant; download
   *    state is intentionally NOT copied — the factory resets it to
   *    `NOT_DOWNLOADED` because a tenant's artifact state is its own.
   *  - Each insert is wrapped in a try/catch so a single failure does not
   *    abort the batch; the failure is logged and the loop continues.
   *  - When zero rows are cloned, a warning is emitted for operators.
   */
  private async provisionTenantModelCatalog(newTenantId: string, plan: TenantPlan | null = null): Promise<void> {
    const sourceModels = await this.aiModelRepository.findAll({
      where: { tenantId: SYSTEM_TENANT_ID },
    });

    // Clone only the plan-appropriate SUBSET. Untagged catalog
    // rows clone into every tier, so this is a no-op for today's (untagged)
    // seed; ops opt models into higher tiers with a `tier:<full|full_custom>`
    // tag. A null plan (ungated/system) resolves to the full catalog.
    const tier = modelTierForPlan(plan);

    let clonedCount = 0;
    for (const src of sourceModels) {
      try {
        if (!modelAllowedForTier(src.tags, tier)) {
          continue;
        }

        // Idempotency: skip slugs the new tenant already owns (backfill-safe).
        const isUnique = await this.aiModelRepository.isSlugUnique(newTenantId, src.slug);
        if (!isUnique) {
          continue;
        }

        const cloned = AiModelFactory.CreateAiModel({
          tenantId: newTenantId,
          name: src.name,
          slug: src.slug,
          description: src.description ?? undefined,
          category: src.category,
          taskType: src.taskType,
          modelType: src.modelType,
          source: src.source,
          sourceUri: src.sourceUri,
          sourceRevision: src.sourceRevision ?? undefined,
          format: src.format,
          // Carry the registry columns through the
          // clone; dropping them left every new tenant with NULL-provider
          // clones that SHADOW the SYSTEM values in the runtime-provider
          // resolvers (same defect the seed backfill already fixed).
          provider: src.provider ?? undefined,
          architecture: src.architecture ?? undefined,
          metaData: src.metaData ?? undefined,
          memorySizeMb: src.memorySizeMb ?? undefined,
          computeType: src.computeType ?? undefined,
          tags: src.tags,
          createdBy: this.requestUser?.id,
        });

        await this.aiModelRepository.create(cloned);
        clonedCount += 1;
      } catch (error) {
        this.logger.warn({
          message: 'Failed to clone AI model for new tenant - continuing',
          newTenantId,
          sourceModelId: src.id,
          sourceSlug: src.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (clonedCount === 0) {
      this.logger.warn({
        message: 'No AI models cloned for new tenant',
        newTenantId,
        systemTenantId: SYSTEM_TENANT_ID,
      });
    }
  }

  /**
   * Clones EVERY enabled SYSTEM `AsrPipeline` (plus each one's current
   * `AsrPipelineVersion`) into the newly created tenant, so a new tenant owns
   * the SAME pipeline catalog as SYSTEM — full parity by policy. This
   * generalizes an earlier single-default-only clone; mirroring
   * `provisionTenantModelCatalog`, which already
   * clones the whole SYSTEM AiModel catalog. Composes as an independent
   * provisioning step.
   *
   * Behaviour:
   *  - Reads the SYSTEM-owned ENABLED pipelines (the shared master catalog).
   *  - Idempotent / backfill-safe per slug: pipelines the new tenant already
   *    owns (`isSlugUnique` === false) are skipped, so this doubles as the
   *    existing-tenant backfill and can grow a tenant's catalog on re-run.
   *  - Builds each clone via `AsrPipelineFactory` bound to the NEW tenant and
   *    copies the source's *current* version (newest by `versionNumber`) as the
   *    clone's v1; when a source has no version rows, v1 is synthesized from the
   *    pipeline-level `configYaml`.
   *  - Stamps template lineage on every clone — `sourceTemplateSlug`
   *    (the SYSTEM template it descends from) and `templateLocked: true`, which
   *    makes the copy read-only for content edits/delete. Tenant admins clone a
   *    copy to customize it; enable/disable and set-default stay available.
   *  - Marks the clone of the SYSTEM default (`isDefault`) as the tenant default
   *    atomically via `setDefaultForTenant` (preserves one-default-per-tenant).
   *  - Per-row failure-isolated (one bad clone never aborts the others or tenant
   *    creation); an empty SYSTEM catalog is a safe no-op (logged for operators).
   */
  private async provisionTenantPipelineCatalog(newTenantId: string): Promise<void> {
    const sources = await this.asrPipelineRepository.findEnabledPipelines(SYSTEM_TENANT_ID);
    if (sources.length === 0) {
      this.logger.warn({
        message: 'No SYSTEM ASR pipelines to clone for new tenant',
        newTenantId,
        systemTenantId: SYSTEM_TENANT_ID,
      });
      return;
    }

    let defaultCloneId: string | undefined;

    for (const source of sources) {
      try {
        // Idempotency: skip the slugs the tenant already owns (backfill-safe).
        const isUnique = await this.asrPipelineRepository.isSlugUnique(newTenantId, source.slug);
        if (!isUnique) {
          continue;
        }

        const clonedPipeline = AsrPipelineFactory.CreateAsrPipeline({
          tenantId: newTenantId,
          name: source.name,
          slug: source.slug,
          description: source.description ?? undefined,
          configYaml: source.configYaml,
          tags: source.tags,
          // The clone IS a template copy: it records which SYSTEM
          // template it descends from and starts LOCKED, so the tenant admin
          // clones it to customize rather than editing it in place.
          // `PipelineService.update/delete` enforce the lock.
          sourceTemplateSlug: source.slug,
          templateLocked: true,
          createdBy: this.requestUser?.id,
        });

        const savedPipeline = await this.asrPipelineRepository.create(clonedPipeline);
        if (source.isDefault) {
          defaultCloneId = savedPipeline.id;
        }

        // Carry the source pipeline's current version YAML (findByPipeline is
        // newest-first) as the clone's v1; fall back to the pipeline-level
        // configYaml when the source has no version rows.
        const sourceVersions = await this.asrPipelineVersionRepository.findByPipeline(source.id);
        const currentVersionYaml = sourceVersions[0]?.configYaml ?? source.configYaml;
        const nextVersionNumber = await this.asrPipelineVersionRepository.getNextVersionNumber(savedPipeline.id);

        const clonedVersion = AsrPipelineVersionFactory.CreateAsrPipelineVersion({
          asrPipelineId: savedPipeline.id,
          versionNumber: nextVersionNumber,
          configYaml: currentVersionYaml,
          name: savedPipeline.name,
          description: savedPipeline.description ?? undefined,
          changeReason: 'Cloned from SYSTEM ASR pipeline catalog on tenant provisioning (TASK-505/356 full parity)',
          changedBy: this.requestUser?.id,
          tenantId: newTenantId,
          createdBy: this.requestUser?.id,
        });

        await this.asrPipelineVersionRepository.create(clonedVersion);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to clone ASR pipeline for new tenant - continuing',
          newTenantId,
          sourcePipelineId: source.id,
          sourceSlug: source.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Tenant-scoped default flip (atomic; unsets any other tenant default first).
    // Only when the SYSTEM default was actually cloned this run.
    if (defaultCloneId) {
      await this.asrPipelineRepository.setDefaultForTenant(newTenantId, defaultCloneId, this.requestUser?.id);
    }
  }

  /**
   * Clones the SYSTEM **agent golden library** into the newly
   * created tenant: every SYSTEM golden department gets a tenant-owned
   * `Department` copy, and every SYSTEM golden `DepartmentAgent` gets a
   * tenant-owned clone bound to an APPROVED PromptTemplate snapshot. This is
   * the DepartmentAgent sibling of `provisionTenantPipelineCatalog` and mirrors
   * its contracts exactly.
   *
   * The golden rows are owned by `SYSTEM_TENANT_ID` and are deliberately NOT
   * SYSTEM-shared reads (a tenant must never see the 18 golden departments in
   * its own list surfaces), so they are read through the UNSCOPED `baseClient` —
   * the sanctioned direct-client access this service already relies on
   * (`getUsageStats`, `updateTenantConfigs`). Writes go through the tenant-bound
   * repositories.
   *
   * Behaviour (mirrors the pipeline catalog):
   *  - Reads the SYSTEM golden agents (the templates to clone) plus the
   *    departments and prompt templates they reference.
   *  - For each golden department: reuses the tenant's same-code department when
   *    it already exists (the bare `GEN` from `provisionDefaultDepartment`, or a
   *    prior run) — else creates the copy. Idempotent / backfill-safe.
   *  - For each golden agent: snapshots the golden PromptTemplate into a
   *    tenant-owned **APPROVED** template (+ v1 `PromptVersion`), then creates
   *    the tenant `DepartmentAgent` clone — `templateLocked: true`,
   *    `sourceAgentTemplateSlug` lineage, and
   *    `metaData.sourceTemplateVersionNumber` (the golden template version the
   *    snapshot was taken from) so the resync sweep can prove it pristine.
   *  - Marks the clone of a golden default agent as the tenant department
   *    default atomically via `setDefaultForDepartment` (preserves
   *    one-default-per-department).
   *  - Per-row failure-isolated (one bad agent never aborts the others or tenant
   *    creation); idempotent per (department, slug) via `isSlugUnique`.
   *  - EMPTY golden set → safe no-op (logged): the bare `GEN` from
   *    `provisionDefaultDepartment` remains the tenant's only department, which
   *    is the prior fallback behaviour.
   */
  private async provisionTenantAgentCatalog(newTenantId: string): Promise<void> {
    const client = this.databaseService.baseClient;

    // Golden agents are the provisioning driver — one default per golden
    // department. Read through the unscoped client (they are SYSTEM-owned and
    // not SYSTEM-shared reads).
    const goldenAgents = await client.departmentAgent.findMany({
      where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED' },
    });

    if (goldenAgents.length === 0) {
      this.logger.warn({
        message: 'No SYSTEM golden agents to clone for new tenant (bare-GEN fallback stands)',
        newTenantId,
        systemTenantId: SYSTEM_TENANT_ID,
      });
      return;
    }

    const goldenDeptIds = [...new Set(goldenAgents.map((a) => a.departmentId))];
    const goldenTemplateIds = [...new Set(goldenAgents.map((a) => a.promptTemplateId))];

    const [goldenDepartments, goldenTemplates] = await Promise.all([
      client.department.findMany({ where: { id: { in: goldenDeptIds } } }),
      client.promptTemplate.findMany({ where: { id: { in: goldenTemplateIds } } }),
    ]);

    const goldenDeptById = new Map(goldenDepartments.map((d) => [d.id, d]));
    const goldenTemplateById = new Map(goldenTemplates.map((t) => [t.id, t]));

    // Resolve/create the tenant department for each golden department code once,
    // then bind agents to it. Keyed by golden department id → tenant department.
    const tenantDeptByGoldenId = new Map<string, DepartmentEntity>();
    for (const goldenDeptId of goldenDeptIds) {
      const goldenDept = goldenDeptById.get(goldenDeptId);
      if (!goldenDept?.code) continue;
      try {
        const tenantDept = await this.resolveOrCreateTenantDepartment(newTenantId, goldenDept);
        tenantDeptByGoldenId.set(goldenDeptId, tenantDept);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to provision golden department for new tenant - continuing',
          newTenantId,
          goldenDepartmentCode: goldenDept.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Collect the per-department default flips and apply them AFTER the clone
    // loop, so the atomic `setDefaultForDepartment` runs once the rows exist.
    const defaultFlips: { departmentId: string; agentId: string }[] = [];

    for (const goldenAgent of goldenAgents) {
      try {
        const tenantDept = tenantDeptByGoldenId.get(goldenAgent.departmentId);
        if (!tenantDept) {
          continue; // its department failed to provision — skip its agents.
        }

        // Idempotency: skip a (department, slug) the tenant already owns.
        const isUnique = await this.departmentAgentRepository.isSlugUnique(newTenantId, tenantDept.id, goldenAgent.slug);
        if (!isUnique) {
          continue;
        }

        const goldenTemplate = goldenTemplateById.get(goldenAgent.promptTemplateId);
        if (!goldenTemplate) {
          continue; // orphaned binding — never clone an agent with no template.
        }

        // Snapshot the golden template into a tenant-owned APPROVED copy so the
        // clone resolves for clinical generation immediately (the golden rows
        // are already super-admin-approved).
        const snapshot = PromptTemplateFactory.CreatePromptTemplate({
          tenantId: newTenantId,
          // Name after the AGENT (unique per department), NOT the shared golden
          // template: the catch-all template backs several departments, so a
          // per-agent snapshot named after the template would collide on the
          // PromptTemplate `(tenantId, name)` unique index.
          name: goldenAgent.name,
          description: goldenTemplate.description ?? undefined,
          content: goldenTemplate.content ?? undefined,
          category: goldenTemplate.category ?? undefined,
          status: 'APPROVED',
          variables: (goldenTemplate.variables as Record<string, unknown> | null) ?? undefined,
          departmentId: tenantDept.id,
          currentVersionNumber: 1,
          tags: goldenTemplate.tags ?? [],
          createdBy: this.requestUser?.id,
        });
        const savedTemplate = await this.promptTemplateRepository.create(snapshot);

        const v1 = PromptVersionFactory.CreatePromptVersion({
          tenantId: newTenantId,
          promptTemplateId: savedTemplate.id,
          versionNumber: 1,
          content: savedTemplate.content ?? undefined,
          variables: (savedTemplate.variables as Record<string, unknown> | null) ?? undefined,
          changeReason: 'Cloned from SYSTEM agent golden library on tenant provisioning (TASK-548)',
          changedBy: this.requestUser?.id,
          createdBy: this.requestUser?.id,
        });
        await this.promptVersionRepository.create(v1);

        const clone = DepartmentAgentFactory.CreateDepartmentAgent({
          tenantId: newTenantId,
          departmentId: tenantDept.id,
          name: goldenAgent.name,
          slug: goldenAgent.slug,
          description: goldenAgent.description ?? undefined,
          promptTemplateId: savedTemplate.id,
          pinnedVersionNumber: null,
          // The clone IS a template copy: locked, with lineage back to the
          // golden slug and the exact source version it was cloned from
          // (pristine-detection anchor for `AgentTemplateResyncService`).
          templateLocked: true,
          sourceAgentTemplateSlug: goldenAgent.slug,
          metaData: { sourceTemplateVersionNumber: goldenTemplate.currentVersionNumber ?? 1 },
          tags: goldenAgent.tags ?? [],
          createdBy: this.requestUser?.id,
        });
        const savedAgent = await this.departmentAgentRepository.create(clone);

        if (goldenAgent.isDefault) {
          defaultFlips.push({ departmentId: tenantDept.id, agentId: savedAgent.id });
        }
      } catch (error) {
        this.logger.warn({
          message: 'Failed to clone golden agent for new tenant - continuing',
          newTenantId,
          goldenAgentSlug: goldenAgent.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Atomic per-department default flip (unsets any prior default first).
    for (const flip of defaultFlips) {
      try {
        await this.departmentAgentRepository.setDefaultForDepartment(newTenantId, flip.departmentId, flip.agentId, this.requestUser?.id);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to set default golden agent for new tenant department - continuing',
          newTenantId,
          departmentId: flip.departmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Resolve the tenant's department for a golden department: reuse the
   * same-code department when it already exists (the bare `GEN` from
   * `provisionDefaultDepartment`, or a prior provisioning run), else clone the
   * golden department's shape into a tenant-owned copy.
   */
  private async resolveOrCreateTenantDepartment(
    newTenantId: string,
    goldenDept: {
      code: string | null;
      name: string | null;
      description: string | null;
      defaultSummaryTemplate: string | null;
      promptConfig: unknown;
    },
  ): Promise<DepartmentEntity> {
    const existing = goldenDept.code ? await this.departmentRepository.findByCode(newTenantId, goldenDept.code) : null;
    if (existing) {
      return existing;
    }

    const department = DepartmentFactory.CreateDepartment({
      tenantId: newTenantId,
      code: goldenDept.code ?? undefined,
      name: goldenDept.name ?? undefined,
      description: goldenDept.description ?? undefined,
      defaultSummaryTemplate: goldenDept.defaultSummaryTemplate ?? undefined,
      // Legacy per-department prompt pointers stay null — the golden agent
      // carries the binding.
      promptConfig: (goldenDept.promptConfig as Record<string, unknown> | null) ?? undefined,
      createdBy: this.requestUser?.id,
    });
    return this.departmentRepository.create(department);
  }

  /**
   * Provisions a default General Practice (`GEN`) department for a newly
   * created tenant so its first admin can satisfy the login
   * invariant (an ENABLED role AND an ENABLED department in the tenant).
   *
   * The department is built from the local `DEFAULT_GEN_DEPARTMENT` template
   * via `DepartmentFactory` and bound to the NEW tenant's id (never the CLS
   * tenant). A `ResourceCreated` SysEvent is broadcast for it, attributed to
   * the `Department` resource type. Failures propagate to the caller, which
   * logs and swallows them so department provisioning never aborts tenant
   * creation (mirrors the bucket/config provisioning blocks).
   */
  private async provisionDefaultDepartment(newTenantId: string): Promise<void> {
    const department = DepartmentFactory.CreateDepartment({
      ...DEFAULT_GEN_DEPARTMENT,
      tenantId: newTenantId,
      createdBy: this.requestUser?.id,
    });

    const saved = await this.departmentRepository.create(department);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      resourceType: ResourceType.Department,
      createdAt: saved.createdAt,
      data: {
        tenantId: newTenantId,
        code: saved.code,
        name: saved.name,
      },
    });
  }

  /**
   * Clones every `GlobalSetting` row from the master `__GLOBAL__` tenant into
   * the newly created tenant so that the SDK and admin UI find a fully
   * populated configuration on first load.
   *
   * Behaviour:
   *  - Looks up the global tenant by `key === GLOBAL_TENANT_KEY` and reads
   *    every setting belonging to it.
   *  - For each source row, builds a clone via `GlobalSettingFactory` whose
   *    `value` starts at `defaultValue ?? value` and copies the descriptive
   *    metadata (`name`, `key`, `dataType`, `description`, `namespace`,
   *    `locked`). The `locked` flag is preserved so admin-restricted defaults
   *    (e.g. `default-stt-model`, `text-provider-models`) remain locked on the
   *    new tenant and are enforced by `updateTenantConfigs`.
   *  - Each insert is wrapped in a try/catch so a single failure (e.g. a
   *    unique-constraint race on `(tenantId, name, key)`) does not abort the
   *    whole batch — the failure is logged and the loop continues.
   *  - When zero rows are cloned, a warning is emitted with the global
   *    tenant id so operators can investigate.
   */
  private async provisionTenantConfigs(newTenantId: string): Promise<void> {
    let globalTenant: TenantEntity | null = null;
    try {
      globalTenant = await this.tenantRepository.findFirst({
        where: { key: GLOBAL_TENANT_KEY },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Global tenant lookup failed during config provisioning',
        newTenantId,
        globalTenantKey: GLOBAL_TENANT_KEY,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!globalTenant) {
      this.logger.warn({
        message: 'Global tenant not found during config provisioning',
        newTenantId,
        globalTenantKey: GLOBAL_TENANT_KEY,
      });
      return;
    }

    const sourceSettings = await this.globalSettingRepository.findAll({
      where: { tenantId: globalTenant.id },
    });

    let clonedCount = 0;
    for (const src of sourceSettings) {
      const seedValue = src.defaultValue ?? src.value;
      try {
        const cloned = GlobalSettingFactory.CreateGlobalSetting({
          tenantId: newTenantId,
          name: src.name,
          key: src.key,
          dataType: src.dataType,
          description: src.description ?? undefined,
          namespace: src.namespace ?? undefined,
          defaultValue: seedValue,
          value: seedValue,
          locked: src.locked,
          createdBy: this.requestUser?.id,
        });

        await this.globalSettingRepository.create(cloned);
        clonedCount += 1;
      } catch (error) {
        this.logger.warn({
          message: 'Failed to clone global setting for new tenant - continuing',
          newTenantId,
          sourceSettingId: src.id,
          sourceKey: src.key,
          sourceName: src.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (clonedCount === 0) {
      this.logger.warn({
        message: 'No global settings cloned for new tenant',
        newTenantId,
        globalTenantId: globalTenant.id,
      });
    }
  }

  /**
   * Existence probe for `generateUniqueTenantKey`. `findFirst`
   * throws `DataNotFoundException` on a miss in production; treated the same
   * as a falsy resolved value (test-double convention) — both mean "free".
   */
  private async tenantKeyExists(key: string): Promise<boolean> {
    try {
      const found = await this.tenantRepository.findFirst({ where: { key } });
      return Boolean(found);
    } catch (error) {
      if (error instanceof DataNotFoundException) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Resolves a tenant by an opaque identifier that may be either a UUID (the
   * tenant primary key) or a tenant `key` / code-name. Replaces the previous
   * ambiguous `OR { id, key }` lookup which could resolve the wrong tenant if
   * a `key` happened to match a UUID format.
   *
   * @throws ArgumentInvalidException if no tenant matches the identifier.
   */
  private async resolveTenantByIdentifier(identifier: string): Promise<TenantEntity> {
    const where = isUuidIdentifier(identifier) ? { id: identifier } : { key: identifier };
    const tenant = await this.tenantRepository.findFirst({ where });

    if (!tenant) {
      throw new ArgumentInvalidException('Tenant not found');
    }

    return tenant;
  }

  /**
   * Fetches all tenants with pagination
   * @param props - Query parameters for pagination and search
   * @returns Promise resolving to paginated tenant response
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<TenantEntity>> {
    const { limit, page } = props;
    const tenants = await this.tenantRepository.findAll(withFormattedPaginatedProps(props, TENANT_FILTER_MODEL));

    const count = await this.tenantRepository.count(withFormattedCountProps(props, TENANT_FILTER_MODEL));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: tenants.map((tenant: TenantEntity) => tenant.id),
      },
    });
    return new FetchResponse<TenantEntity>({
      data: tenants,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetches all tenants by code name
   * @param props - Query parameters including code name, pagination and search
   * @returns Promise resolving to paginated tenant response
   */
  async fetchAllByTenantCodeName(props: PaginatedQuery & { codeName: string }): Promise<FetchResponse<TenantEntity>> {
    const { codeName, limit, page } = props;
    const tenants = await this.tenantRepository.findAll({
      ...withFormattedPaginatedProps(props, TENANT_FILTER_MODEL),
      where: {
        key: codeName,
      },
    });
    const count = await this.tenantRepository.count({
      ...withFormattedCountProps(props, TENANT_FILTER_MODEL),
      where: {
        key: codeName,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        key: codeName,
        items: tenants.map((tenant: TenantEntity) => tenant.id),
      },
    });
    return new FetchResponse<TenantEntity>({
      data: tenants,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetches all tenants created by a specific user
   * @param props - Query parameters including user ID, pagination and search
   * @returns Promise resolving to paginated tenant response
   */
  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<TenantEntity>> {
    const { userId, limit, page } = props;
    const tenants = await this.tenantRepository.findAll({
      ...withFormattedPaginatedProps(props, TENANT_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.tenantRepository.count({
      ...withFormattedCountProps(props, TENANT_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: tenants.map((tenant: TenantEntity) => tenant.id),
      },
    });
    return new FetchResponse<TenantEntity>({
      data: tenants,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetches a tenant by ID.
   *
   * Short-circuits with
   * `NotFoundException` when the resolved row's id does not match the
   * CLS-supplied caller `tenantId`, except for SUPER_ADMIN callers, who
   * remain authorized for cross-tenant reads (admin UI tenant pickers).
   * Pre-guard, ANY tenant could be read by primary key, allowing
   * tenant-record enumeration across the tenant boundary.
   *
   * @param id - The tenant ID
   * @returns Promise resolving to the tenant entity
   * @throws NotFoundException when the caller is not authorized to read the row
   */
  async fetchById(id: EntityId): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);

    if (tenant.id !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: tenant.id,
      data: tenant.toObject() as object,
    });
    return tenant;
  }

  /**
   * Fetches a tenant by code-name (`key`).
   *
   * Mirrors the `fetchById`
   * tenant-scope guard so a caller cannot enumerate another tenant by
   * code-name. SUPER_ADMIN callers retain the cross-tenant bypass.
   *
   * @param codeName - The tenant code-name (matches the `key` column)
   * @returns Promise resolving to the tenant entity
   * @throws NotFoundException when the caller is not authorized to read the row
   */
  async fetchByCodeName(codeName: string): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findFirst({
      where: {
        key: codeName,
      },
    });

    if (tenant.id !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        key: codeName,
        id: tenant.id,
      },
    });
    return tenant;
  }

  /**
   * Updates a tenant
   * @param id - The tenant ID
   * @param request - The update request containing changes (including
   *   the mandatory `expectedVersion` carried from the prior GET — see
   *   `UpdateTenantRequest`).
   * @returns Promise resolving to the updated tenant
   * @throws ArgumentInvalidException if no changes are detected
   * @throws OptimisticConcurrencyException if the row's `_version` drifted
   *   under us (CAS predicate matched zero rows). The HTTP layer renders
   *   this as `412 Precondition Failed` via the Phase D ExceptionFilter.
   *
   * @see Tenant OCC migration
   */
  async update(id: EntityId, request: UpdateTenantRequest): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);

    const previousData = tenant.toObject();
    // `expectedVersion` is the CAS predicate input only — keep it out of
    // `updateEntity` so it is never written onto the entity or staged for
    // persistence. The DTO declares it but the entity has no such setter
    // (the `_version` getter is read-only per B.5).
    const { expectedVersion, ...editableRequest } = request;
    this.updateEntity(tenant, editableRequest as UpdateTenantRequest);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(tenant, expectedVersion);
    if (!tenant.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // Snapshot the row's pre-write version BEFORE the CAS bumps it. After
    // `updateWithVersion` returns, `tenant.version` (round-tripped from the
    // DB) will already be the new version. Mirrors the pattern used by
    // `updateTenantConfigs`.
    const previousVersion = tenant.version;

    // Compare-And-Set against `_version`.
    // The repository wraps `prisma.tenant.updateMany` in a predicate that
    // requires `_version === expectedVersion`; a mismatch surfaces as
    // `OptimisticConcurrencyException`. We deliberately drop the legacy
    // `tenantRepository.update(id, tenant)` write path, which bypassed OCC.
    const updatedTenant = await this.tenantRepository.updateWithVersion(id, tenant, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedTenant.id,
      data: {
        ...tenant.changes,
        // Carry the version transition so audit consumers can correlate the
        // change with the row's prior state.
        previousVersion,
        newVersion: updatedTenant.version,
      },
      previousData,
    });
    return updatedTenant;
  }

  /**
   * Soft deletes a tenant by ID.
   *
   * (#1 / DEF-ADM-002) — the reserved system/default tenant is loaded
   * first and blocked from deletion so an operator cannot soft-delete the
   * platform's `__GLOBAL__` (or `SYSTEM_TENANT_ID`) row.
   *
   * @param id - The tenant ID
   * @returns Promise resolving to the deleted tenant
   */
  async deleteById(id: EntityId): Promise<TenantEntity> {
    const existing = await this.tenantRepository.findById(id);
    this.assertNotSystemTenant(existing);

    const tenant = await this.tenantRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: tenant.id,
      data: tenant.toObject() as object,
    });
    return tenant;
  }

  /**
   * (#1 / DEF-ADM-002) — blocks lifecycle mutations against the
   * reserved system tenant. The system tenant is identified either by its
   * `key` equal to `__GLOBAL__` (compared case-insensitively, mirroring the
   * DEF-ADM-001 key protection) or by the reserved `SYSTEM_TENANT_ID`.
   */
  private assertNotSystemTenant(tenant: TenantEntity): void {
    const isGlobalKey = (tenant.key ?? '').toUpperCase() === GLOBAL_TENANT_KEY.toUpperCase();
    if (isGlobalKey || tenant.id === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('The system tenant cannot be suspended, archived, or deleted.');
    }
  }

  /**
   * Moves a tenant to `SUSPENDED` (reversible operator
   * hold). Blocked on the system tenant. Non-OCC operator transition.
   */
  async suspend(id: EntityId): Promise<TenantEntity> {
    return this.transitionLifecycle(id, (tenant) => tenant.suspend(this.requestUser?.id), { guardSystem: true });
  }

  /**
   * Moves a tenant to `ARCHIVED` (recoverable cold state).
   * Blocked on the system tenant. Non-OCC operator transition.
   */
  async archive(id: EntityId): Promise<TenantEntity> {
    return this.transitionLifecycle(id, (tenant) => tenant.archive(this.requestUser?.id), { guardSystem: true });
  }

  /**
   * Restores a suspended/archived tenant back to
   * `ENABLED`. Restore is always permitted (a system tenant should never be in
   * a non-enabled state, but restoring it is harmless).
   */
  async restore(id: EntityId): Promise<TenantEntity> {
    return this.transitionLifecycle(id, (tenant) => tenant.enable(this.requestUser?.id), { guardSystem: false });
  }

  /**
   * Shared lifecycle transition: load → (optionally guard system tenant) →
   * apply the entity state change → persist (non-OCC) → audit.
   */
  private async transitionLifecycle(
    id: EntityId,
    apply: (tenant: TenantEntity) => TenantEntity,
    options: { guardSystem: boolean },
  ): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);
    if (options.guardSystem) {
      this.assertNotSystemTenant(tenant);
    }

    const previousData = tenant.toObject();
    apply(tenant);

    const updated = await this.tenantRepository.update(id, tenant);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...tenant.changes },
      previousData,
    });
    return updated;
  }

  /**
   * Replaces the tenant's full tag set (idempotent set semantics) under
   * optimistic concurrency.
   *
   * `PUT /admin/tenants/:id/tags` carries `@RequiresIfMatch()`, so
   * `expectedVersion` is always supplied by a browser client; it stays optional
   * here for the documented service-to-service body fallback.
   */
  async setTags(id: EntityId, tags: string[], expectedVersion?: number): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);

    const previousData = tenant.toObject();
    tenant.tags = tags;

    // OCC precondition BEFORE the no-changes short-circuit: re-sending the
    // SAME tag set is the common case here, and a stale client must still be
    // told to refetch (412) rather than get a silent 200 off the idempotent
    // return below. The CAS still guards writers racing after this comparison.
    this.assertExpectedVersion(tenant, expectedVersion);
    if (!tenant.hasChanges) {
      return tenant;
    }

    const updated =
      expectedVersion === undefined
        ? await this.tenantRepository.update(id, tenant)
        : await this.tenantRepository.updateWithVersion(id, tenant, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...tenant.changes },
      previousData,
    });
    return updated;
  }

  /**
   * Tenant configuration methods
   */

  /**
   * Fetches configurations for a specific tenant.
   *
   * Identifier resolution: either `tenantId` (UUID primary key) or `codeName`
   * (tenant `key`) must be provided. The active identifier is disambiguated
   * via `resolveTenantByIdentifier` — UUID-shaped values use `id`, otherwise
   * we look up by `key`. This avoids the previous broad `OR { id, key }`
   * lookup which could resolve the wrong tenant.
   *
   * Locked-value masking: settings whose `locked === true` are sensitive
   * defaults (e.g. provider credentials). When the active caller does not
   * carry the `SUPER_ADMIN` role, the `value` of every locked row is replaced
   * with an empty string before the response is returned. The original entity
   * instance is mutated via its setter, which is safe because each fetch
   * yields freshly constructed entities; no shared in-memory state escapes.
   *
   * @param props - Query parameters including tenant ID or codeName + pagination
   * @returns Promise resolving to paginated configuration response
   * @throws ArgumentInvalidException if neither identifier is provided or the tenant cannot be found
   */
  async fetchTenantConfigs(props: PaginatedQuery & { tenantId?: string; codeName?: string }): Promise<FetchResponse<GlobalSettingEntity>> {
    const { limit, page, tenantId, codeName } = props;

    if (!tenantId && !codeName) {
      throw new ArgumentInvalidException('Tenant ID or Tenant Code is required');
    }

    const identifier = (tenantId ?? codeName) as string;
    const tenant = await this.resolveTenantByIdentifier(identifier);

    // Caller-identity check. Non-SUPER_ADMIN
    // callers are restricted to their CLS tenant; cross-tenant reads (including
    // codeName lookups that resolve to another tenant) short-circuit with
    // `NotFoundException` so the API does not leak the existence of foreign
    // tenants' config rows. SUPER_ADMIN retains the cross-tenant bypass for
    // admin UI tenant pickers + platform-metadata flows (mirrors the
    // `fetchById` / `fetchByCodeName` posture).
    if (tenant.id !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    const paginatedProps = withFormattedPaginatedProps(props);
    const countProps = withFormattedCountProps(props);

    const tenantWhere = { tenantId: tenant.id };

    const [configs, count] = await Promise.all([
      this.globalSettingRepository.findAll({
        ...paginatedProps,
        where: { ...paginatedProps.where, ...tenantWhere },
      }),
      this.globalSettingRepository.count({
        ...countProps,
        where: { ...countProps.where, ...tenantWhere },
      }),
    ]);

    const isSuperAdmin = this.isSuperAdmin();
    if (!isSuperAdmin) {
      for (const config of configs) {
        if (config.locked === true) {
          config.value = '';
        }
      }
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId: tenant.id,
        items: configs.map((config) => config.id),
      },
    });

    return new FetchResponse<GlobalSettingEntity>({
      data: configs,
      count,
      limit,
      page,
    });
  }

  /**
   * Updates configurations for a specific tenant.
   *
   * Access control:
   *  - Tenant identifier is disambiguated via `resolveTenantByIdentifier`
   *    (UUID -> `id`, otherwise `key`).
   *  - All writes against the master `__GLOBAL__` tenant are rejected with
   *    `ForbiddenException` unless the caller carries the `SUPER_ADMIN`
   *    role, preventing accidental mutation of the system defaults.
   *  - Each individual setting whose `locked === true` is rejected with
   *    `ForbiddenException` for non-super-admins. Super-admins may update
   *    locked rows.
   *
   * @param identifier - The tenant id (UUID) or code name (`key`)
   * @param request - Array of config update payloads (id + partial fields)
   * @returns Promise resolving to array of updated configurations
   * @throws ArgumentInvalidException if tenant or config not found, or config belongs to another tenant
   * @throws ForbiddenException if a non-super-admin attempts to write to a locked row or to the global tenant
   * @throws InternalServerErrorException if a repository update returns null
   */
  async updateTenantConfigs(identifier: EntityId | string, request: UpdateTenantConfigRequest[]): Promise<FetchResponse<GlobalSettingEntity>> {
    const tenant = await this.resolveTenantByIdentifier(identifier);

    const isSuperAdmin = this.isSuperAdmin();

    if (tenant.key === GLOBAL_TENANT_KEY && !isSuperAdmin) {
      throw new ForbiddenException(`Tenant '${GLOBAL_TENANT_KEY}' holds system defaults and can only be modified by ${SUPER_ADMIN_ROLE} users.`);
    }

    // All-or-nothing via Prisma's
    // interactive transaction. Each per-row CAS is issued through the
    // tx client; if any row's `_version` drifted (or any other failure
    // bubbles out of the callback) the SQL transaction is automatically
    // rolled back, including the already-applied earlier rows. The
    // success-only `broadcastSysEvent(ResourceUpdated)` lives OUTSIDE
    // the callback so a rolled-back batch produces no audit entry that
    // would mislead downstream observers.
    //
    // Note: we deliberately do NOT route through `CoreUnitOfWorkService`
    // because its `startTransaction()` issues `$transaction(async (tx) => tx)`
    // which commits the transaction before any subsequent caller can use
    // the tx client — i.e., the existing UoW pattern is non-functional.
    // Using `databaseService.baseClient.$transaction(callback)` directly
    // is the canonical Prisma idiom and delivers actual atomicity.
    // Snapshot each row's `_version`
    // BEFORE the CAS so the post-write audit-log SysEvent can carry the
    // exact transition (previousVersion -> newVersion). Investigators then
    // reconstruct history via `metadata->>'newVersion'` without re-deriving
    // from timestamps. Index aligns with `results` below.
    const previousVersions: number[] = [];

    const updatedConfigs: GlobalSettingEntity[] = await this.databaseService.baseClient.$transaction(async (tx) => {
      const results: GlobalSettingEntity[] = [];
      for (const config of request) {
        const existingConfig = await this.globalSettingRepository.findById(config.id);

        if (!existingConfig) {
          throw new ArgumentInvalidException(`Config with id ${config.id} not found`);
        }

        if (existingConfig.tenantId !== tenant.id) {
          throw new ArgumentInvalidException(`Config ${config.id} does not belong to tenant ${tenant.id}`);
        }

        if (existingConfig.locked === true && !isSuperAdmin) {
          throw new ForbiddenException(`Setting '${existingConfig.key}' is locked and can only be modified by ${SUPER_ADMIN_ROLE} users.`);
        }

        if (config.value !== undefined) {
          await this.validateProviderModel(existingConfig.key, config.value, tenant.id);
        }

        // Explicit allowlist.
        // NEVER spread `config` directly into `updateEntity`: that path
        // assigns every key on the entity (mass-assignment) and lets a
        // caller smuggle `key`, `tenantId`, `locked`, `defaultValue` into
        // a GlobalSettingEntity even if the HTTP ValidationPipe is
        // bypassed. Only `value` and `description` are mutable here.
        const changes: { value?: string; description?: string } = {};
        if (config.value !== undefined) {
          changes.value = config.value;
        }
        if (config.description !== undefined) {
          changes.description = config.description;
        }
        this.updateEntity(existingConfig, changes);

        // Snapshot the pre-write version BEFORE the CAS bumps the
        // entity's `_version`. The repo round-trips the bumped version,
        // so reading `existingConfig.version` AFTER the CAS would emit
        // `previousVersion === newVersion` and break audit correlation.
        const previousVersion = existingConfig.version;

        // OCC precondition BEFORE the no-changes short-circuit: a stale client must
        // get 412 ("you are stale, refetch"), not 400/200, even when the payload
        // would change nothing. RFC 7232 evaluates preconditions independently of
        // the payload; the CAS below still guards concurrent writers.
        this.assertExpectedVersion(existingConfig, config.expectedVersion, 'globalSetting');
        if (!existingConfig.hasChanges) {
          results.push(existingConfig);
          previousVersions.push(previousVersion);
          continue;
        }

        // Compare-And-Set against `_version`.
        // The `OptimisticConcurrencyException` propagates straight out of
        // the callback, aborting the outer `$transaction` atomically.
        // The HTTP layer's ExceptionFilter renders `412 Precondition
        // Failed` with `{ currentVersion, yourVersion }`.
        const updatedConfig = await this.globalSettingRepository.updateWithVersion(existingConfig.id, existingConfig, config.expectedVersion, tx);

        if (!updatedConfig) {
          throw new InternalServerErrorException(`Failed to update GlobalSettingEntity with id: ${config.id}`);
        }

        results.push(updatedConfig);
        previousVersions.push(previousVersion);
      }
      return results;
    });

    // Scrub @Secret fields when locked.
    // Per-entity decision: a mixed batch emits a partially-scrubbed array.
    // Broadcast lives OUTSIDE the transaction so a rolled-back batch
    // produces no `Resource.Updated` audit entry.
    // Carry the per-row version transition so audit consumers can
    // correlate the change with the row's prior state. Merging happens AFTER
    // `scrubLockedForAudit` so the (potentially frozen) scrubbed object's
    // metadata fields are appended via spread, not in-place mutation.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceIds: updatedConfigs.map((config) => config.id),
      data: updatedConfigs.map((config, i) => ({
        ...scrubLockedForAudit(config),
        previousVersion: previousVersions[i],
        newVersion: config.version,
      })),
    });

    return new FetchResponse<GlobalSettingEntity>({
      data: updatedConfigs,
      count: updatedConfigs.length,
      limit: 0,
      page: 0,
    });
  }

  /**
   * Get usage statistics for a tenant.
   *
   * Extended beyond a basic user/department/prompt-template count with the
   * storage + clinical roll-ups the Tenant Detail "Overview"/"Storage" tiles
   * need. All aggregates read `databaseService.client` directly (house
   * precedent) and are scoped by the explicit `tenantId` argument:
   *   - storageUsedBytes   = SUM(Media.size)
   *   - storageQuotaBytes  = SUM(TenantBucket.quotaBytes) over configured
   *                          buckets, else null ("no quota configured")
   *   - transcriptionMinutes = SUM(AudioRecording.duration ms)/60000
   *   - summaries24h       = COUNT(SummaryMeta WHERE generatedAt >= now-24h)
   *   - totalConsultations = COUNT(Consultation)
   *
   * @param tenantId - The tenant ID
   */
  async getUsageStats(tenantId: EntityId): Promise<{
    totalUsers: number;
    totalDepartments: number;
    totalPromptTemplates: number;
    totalPipelines: number;
    storageUsedBytes: number;
    storageQuotaBytes: number | null;
    transcriptionMinutes: number;
    summaries24h: number;
    totalConsultations: number;
  }> {
    await this.tenantRepository.findById(tenantId);

    const client = this.databaseService.client;
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      distinctUserAssignments,
      totalDepartments,
      totalPromptTemplates,
      totalPipelines,
      sizeAgg,
      quotaAgg,
      durationAgg,
      summaries24h,
      totalConsultations,
    ] = await Promise.all([
      client.userRoleAssignment.findMany({
        where: { tenantId },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.departmentRepository.count({ where: { tenantId } }),
      this.promptTemplateRepository.count({ where: { tenantId } }),
      this.asrPipelineRepository.count({ where: { tenantId } }),
      client.media.aggregate({ _sum: { size: true }, where: { tenantId } }),
      client.tenantBucket.aggregate({ _sum: { quotaBytes: true }, where: { tenantId, quotaBytes: { not: null } } }),
      client.audioRecording.aggregate({ _sum: { duration: true }, where: { tenantId } }),
      client.summaryMeta.count({ where: { tenantId, generatedAt: { gte: since24h } } }),
      client.consultation.count({ where: { tenantId } }),
    ]);

    const durationMs = durationAgg._sum.duration ?? 0;
    const quotaSum = quotaAgg._sum.quotaBytes;

    return {
      totalUsers: distinctUserAssignments.length,
      totalDepartments,
      totalPromptTemplates,
      totalPipelines,
      storageUsedBytes: sizeAgg._sum.size ?? 0,
      storageQuotaBytes: quotaSum === null || quotaSum === undefined ? null : Number(quotaSum),
      transcriptionMinutes: Math.round((durationMs / 60000) * 100) / 100,
      summaries24h,
      totalConsultations,
    };
  }

  /**
   * True when the active request user carries the `SUPER_ADMIN` role.
   * Falls back to `false` whenever the CLS context is missing or the role
   * list is undefined — locking the strictest behaviour by default.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * Reusable provider/model validation shared by the TEXT and
   * Guardrail engines (generalised from the original `validateTextConfigValue`).
   *
   * When a `default-*-provider` / `default-*-model` setting is updated, the new
   * value is validated against that domain's per-tenant `*-provider-models`
   * catalog so the admin console can never persist an unknown provider/model
   * combination. It is a no-op for every other setting key, so the batch update
   * loop can safely call it for every config. TEXT behaviour and error messages
   * are preserved verbatim; Guardrail reuses the identical logic with its own
   * catalog + a `Guardrail` label.
   */
  private async validateProviderModel(settingKey: string, newValue: string, tenantId: string): Promise<void> {
    // Each domain wires its provider/model keys to its catalog + current-provider
    // readers. Adding a future engine is a single entry here.
    const domains = [
      {
        label: 'TEXT',
        providerKey: 'default-text-provider',
        modelKey: 'default-text-model',
        loadCatalog: () => this.loadTextCatalog(tenantId),
        getCurrentProvider: () => this.getCurrentTextProvider(tenantId),
      },
      {
        label: 'Guardrail',
        providerKey: 'default-guardrail-provider',
        modelKey: 'default-guardrail-model',
        loadCatalog: () => this.loadGuardrailCatalog(tenantId),
        getCurrentProvider: () => this.getCurrentGuardrailProvider(tenantId),
      },
    ];

    const domain = domains.find((d) => d.providerKey === settingKey || d.modelKey === settingKey);
    if (!domain) {
      return;
    }

    const catalog = await domain.loadCatalog();
    if (!catalog || catalog.length === 0) {
      return;
    }

    if (settingKey === domain.providerKey) {
      const validProviders = catalog.map((entry: { provider: string }) => entry.provider);
      if (!validProviders.includes(newValue)) {
        throw new ArgumentInvalidException(`'${newValue}' is not a valid ${domain.label} provider. ` + `Available: ${validProviders.join(', ')}`);
      }
    }

    if (settingKey === domain.modelKey) {
      const currentProvider = await domain.getCurrentProvider();
      const providerEntry = catalog.find((entry: { provider: string }) => entry.provider === currentProvider);
      if (providerEntry) {
        const validModels = providerEntry.models.map((m: { name: string }) => m.name);
        if (!validModels.includes(newValue)) {
          throw new ArgumentInvalidException(
            `'${newValue}' is not a valid model for provider '${currentProvider}'. ` + `Available: ${validModels.join(', ')}`,
          );
        }
      }
    }
  }

  /**
   * Generic loader for a `ux-constants` provider/model catalog (TEXT or
   * Guardrail). Returns `null` when the catalog row is missing or malformed so
   * callers treat validation as a no-op rather than blocking the update.
   */
  private async loadCatalog(tenantId: string, catalogKey: string): Promise<{ provider: string; models: { name: string; size: string }[] }[] | null> {
    const settings = await this.globalSettingRepository.findAll({
      where: {
        tenantId,
        key: catalogKey,
      },
    });

    const catalogSetting = settings.find((s: GlobalSettingEntity) => s.key === catalogKey);
    if (!catalogSetting?.value) return null;

    try {
      const parsed = JSON.parse(catalogSetting.value);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].provider) {
        return parsed;
      }
    } catch {
      // Malformed catalog, skip validation
    }
    return null;
  }

  /**
   * Generic reader for the currently-selected provider of a domain
   * (`default-text-provider` / `default-guardrail-provider`). Defaults to the
   * primary local engine `lm-studio` when unset.
   */
  private async getCurrentProvider(tenantId: string, providerKey: string): Promise<string> {
    const settings = await this.globalSettingRepository.findAll({
      where: {
        tenantId,
        key: providerKey,
      },
    });

    const providerSetting = settings.find((s: GlobalSettingEntity) => s.key === providerKey);
    return providerSetting?.value?.trim() || 'lm-studio';
  }

  /** TEXT provider/model catalog for this tenant. */
  private loadTextCatalog(tenantId: string) {
    return this.loadCatalog(tenantId, 'text-provider-models');
  }

  /** Currently-selected TEXT provider for this tenant. */
  private getCurrentTextProvider(tenantId: string) {
    return this.getCurrentProvider(tenantId, 'default-text-provider');
  }

  /** Guardrail provider/model catalog for this tenant. */
  private loadGuardrailCatalog(tenantId: string) {
    return this.loadCatalog(tenantId, 'guardrail-provider-models');
  }

  /** Currently-selected Guardrail provider for this tenant. */
  private getCurrentGuardrailProvider(tenantId: string) {
    return this.getCurrentProvider(tenantId, 'default-guardrail-provider');
  }
}
