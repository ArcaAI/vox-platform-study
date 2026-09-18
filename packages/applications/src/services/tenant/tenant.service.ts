import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  SysEventType,
  EntityId,
  TenantEntity,
  TenantFactory,
  TenantRepository,
  GlobalSettingRepository,
  GlobalSettingEntity,
  CoreDatabaseService,
  DepartmentRepository,
  DepartmentFactory,
  DepartmentEntity,
  PromptTemplateRepository,
  AsrPipelineRepository,
  AsrPipelineFactory,
  AsrPipelineVersionRepository,
  AsrPipelineVersionFactory,
  AiModelRepository,
  TenantPlan,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { ITenantService } from './ITenantService';
import { CreateTenantRequest, UpdateTenantRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UpdateTenantConfigRequest } from './dto/updateTenantConfigRequest';
import { ITenantBucketService } from '../tenant-bucket/ITenantBucketService';
import { GLOBAL_TENANT_KEY, SEED_TENANT_ID, SUPER_ADMIN_ROLE, isUuidIdentifier } from './constants';
import { DEFAULT_GEN_DEPARTMENT } from './departmentDefaults';
import { scrubLockedForAudit } from './scrubbing';
import { generateUniqueTenantKey } from './tenantKey';
import { ITenantReferenceSetService } from './reference-set/ITenantReferenceSetService';
import { IBillingService } from '../billing/IBillingService';

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
    // Retained for constructor ARITY only. Its user, `provisionTenantModelCatalog`, was
    // deleted by TASK-890 L13 (OD-O: the catalogue is CONFIG, stays SYSTEM-shared-read, and is
    // never cloned). Removing the positional dependency would renumber every argument after it
    // in six test fixtures for no behavioural gain; it goes with the ASR-pipeline clone under
    // TASK-901, which owns the two parameters that follow.
    private readonly _retiredAiModelRepository: AiModelRepository,
    // Appended last (append-only). Used
    // to clone the SYSTEM default ASR pipeline's current version into each new
    // tenant alongside the pipeline itself.
    private readonly asrPipelineVersionRepository: AsrPipelineVersionRepository,
    /**
     * TASK-890 §3.4 — the SYSTEM reference set. `@Optional()` + trailing, the house convention:
     * production DI supplies it through `TenantServiceModule`; the positional unit fixtures do
     * not, and a tenant created without it is provisioned with no platform content — which the
     * step above LOGS rather than hides, because that is exactly the state proof #9 looks for.
     */
    @Optional() @Inject(ITenantReferenceSetService) private readonly referenceSet?: ITenantReferenceSetService,
    /**
     * TASK-986 (owner ruling D-7) — the `TenantPlanHistory` writer. `@Optional()`
     * + trailing, the same house convention as `referenceSet` above: production
     * DI supplies it through `TenantServiceModule`, the positional unit
     * fixtures do not, and a missing writer degrades to a logged warning rather
     * than failing a plan write that has already committed.
     */
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
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

    // Write the plan's storageQuotaBytes onto the primary
    // system bucket now that buckets exist.
    await this.applyPlanStorageQuotaBestEffort(tenant.id, tenant.plan ?? null);

    // TASK-986 (owner ruling D-7) — open the tenant's FIRST plan-history
    // window. `TenantPlanHistory` is what the invoice engine prorates the plan
    // fee from; before this call its only writer had zero production callers,
    // so every tenant billed against an empty history.
    await this.recordPlanChangeBestEffort(tenant.id, tenant.plan ?? null, 'initial');

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
      await this.provisionTenantPipelineCatalog(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision ASR pipeline catalog for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.provisionTenantDepartmentCatalog(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision the golden department catalog for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // TASK-890 §3.4 (OD-H / OD-M) — the SYSTEM REFERENCE SET: context schemas, prompt
    // templates, agents (+ their TENANT assignments) and workflow definitions, CLONED into the
    // new tenant. This is the step that makes the runtime's content plane tenant-only: after
    // L13 step v nothing widens a content read to SYSTEM, so a tenant that was never
    // provisioned resolves `AGENT_NOT_ASSIGNED` / `PROMPT_DEFAULT_NOT_PROVISIONED` rather than
    // quietly serving the platform's rows.
    //
    // Best-effort like its six siblings — a copy that fails must not fail the tenant — and the
    // summary it returns names every failure. `POST /admin/tenants/:id/reference-set/sync` is
    // the repair, and §4.4 proof #9 is what catches a tenant this step could not complete.
    try {
      const summary = await this.referenceSet?.provision(tenant.id);
      if (summary && summary.warnings.length > 0) {
        this.logger.warn({ message: 'Reference set provisioned with warnings', tenantId: tenant.id, warnings: summary.warnings });
      }
      if (!this.referenceSet) {
        this.logger.warn({ message: 'Reference-set service is not wired; the new tenant has no platform content', tenantId: tenant.id });
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision the SYSTEM reference set for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return tenant;
  }

  /**
   * Clones EVERY enabled SYSTEM `AsrPipeline` (plus each one's current
   * `AsrPipelineVersion`) into the newly created tenant, so a new tenant owns
   * the SAME pipeline catalog as SYSTEM — full parity by policy. This
   * generalizes an earlier single-default-only clone. Composes as an
   * independent provisioning step.
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
          changeReason: 'Cloned from SYSTEM ASR pipeline catalog on tenant provisioning (full parity)',
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
   * Clones the SYSTEM **golden department catalog** into the newly created
   * tenant: every SYSTEM golden department gets a tenant-owned `Department`
   * copy. This is the department sibling of `provisionTenantPipelineCatalog`
   * and mirrors its contracts exactly.
   *
   * ## What this used to also do
   *
   * It cloned a SYSTEM golden `DepartmentAgent` per department, snapshotting the
   * golden prompt template into a tenant-owned APPROVED copy and stamping
   * lineage so the nightly resync sweep could prove the clone pristine. All of
   * that went with `DepartmentAgent`: a prompt template's binding to a workflow
   * lives on the NODE that references it, and a new tenant authors that
   * binding in the Workflow Studio rather than inheriting eighteen rows.
   *
   * The DEPARTMENT half stayed, and the driver had to change with it. It used
   * to iterate golden AGENTS and provision each one's department; it now
   * iterates the golden DEPARTMENTS directly. Without that change a new tenant
   * would silently get only the bare `GEN` department from
   * `provisionDefaultDepartment` — a capability quietly lost to the deletion of
   * something else.
   *
   * The golden rows are owned by `SYSTEM_TENANT_ID` and are deliberately NOT
   * SYSTEM-shared reads (a tenant must never see the 18 golden departments in
   * its own list surfaces), so they are read through the UNSCOPED `baseClient` —
   * the sanctioned direct-client access this service already relies on
   * (`getUsageStats`, `updateTenantConfigs`). Writes go through the tenant-bound
   * repositories.
   *
   * Behaviour (mirrors the pipeline catalog):
   *  - For each golden department: reuses the tenant's same-code department when
   *    it already exists (the bare `GEN` from `provisionDefaultDepartment`, or a
   *    prior run) — else creates the copy. Idempotent / backfill-safe.
   *  - Per-row failure-isolated (one bad department never aborts the others or
   *    tenant creation).
   *  - EMPTY golden set → safe no-op (logged): the bare `GEN` remains the
   *    tenant's only department, which is the prior fallback behaviour.
   */
  private async provisionTenantDepartmentCatalog(newTenantId: string): Promise<void> {
    const client = this.databaseService.baseClient;

    // Read through the unscoped client (SYSTEM-owned, and not SYSTEM-shared reads).
    const goldenDepartments = await client.department.findMany({
      where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED' },
    });

    if (goldenDepartments.length === 0) {
      this.logger.warn({
        message: 'No SYSTEM golden departments to clone for new tenant (bare-GEN fallback stands)',
        newTenantId,
        systemTenantId: SYSTEM_TENANT_ID,
      });
      return;
    }

    for (const goldenDept of goldenDepartments) {
      if (!goldenDept.code) continue;
      try {
        await this.resolveOrCreateTenantDepartment(newTenantId, goldenDept);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to provision golden department for new tenant - continuing',
          newTenantId,
          goldenDepartmentCode: goldenDept.code,
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

    // TASK-986 W1 (owner ruling D-5) — ALL PATCH edits are blocked on the two
    // reserved rows. This method previously called no reserved guard at all,
    // so `{"resourceStatus":"DISABLED"}` deactivated the platform tier, and a
    // `key` rename disarmed the suspend/archive/delete guard for Global.
    this.assertNotSystemTenant(tenant, 'edited');

    // TASK-986 W2 (owner decision D-1) — `plan` is a SUPER_ADMIN-only FIELD.
    // The route decorator (`@CanAny(['manage','Tenant'],['update','Tenant'])`)
    // cannot express "every field but this one": the seed grants a tenant admin
    // `update:Tenant` on its OWN id, which would otherwise let it raise its own
    // plan — and "entitlements bound what a tenant MAY set; they never supply a
    // value" (`00-project-context.md`). Existence is resolved by the `findById`
    // above FIRST, so an unknown id is still a 404 and this gate is never an
    // existence oracle (rule 05 §"Imperative Privilege Checks"). It fires only
    // on an ACTUAL change: echoing the stored plan back is not a plan change.
    const previousPlan = tenant.plan ?? null;
    const requestsPlanChange = request.plan !== undefined && request.plan !== previousPlan;
    if (requestsPlanChange && !this.isSuperAdmin()) {
      throw new ForbiddenException('Only a platform administrator can change a tenant plan.');
    }

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

    // TASK-986 (owner ruling D-7) — a plan change is not just a column write.
    // `TenantPlanHistory` is what the invoice engine prorates the plan fee
    // from, and the bucket quota is derived from the plan; neither was wired to
    // this path before, so an upgraded tenant billed against an EMPTY history
    // and kept its old storage ceiling. Best-effort, like every other side
    // effect on this service: the plan write itself has already committed.
    //
    // Both writes go through TENANT-SCOPED repositories, and a super admin
    // editing tenant B while their working tenant is A carries A in CLS — the
    // tenant-scope extension would then refuse the explicit `tenantId: B` as a
    // mismatch. So rebind CLS to the row we just legitimately wrote, and
    // restore it before the audit broadcast below (which attributes to CLS).
    if (requestsPlanChange) {
      await this.runForTenant(updatedTenant.id, async () => {
        await this.recordPlanChangeBestEffort(updatedTenant.id, updatedTenant.plan ?? null, 'plan-updated');
        await this.applyPlanStorageQuotaBestEffort(updatedTenant.id, updatedTenant.plan ?? null);
      });
    }

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
   * (#1 / DEF-ADM-002) — blocks mutations against either RESERVED tenant:
   * SYSTEM (`00000000-…`, the configuration tier) and Global (`50000000-…`,
   * the platform-admin playground).
   *
   * Matching is by IMMUTABLE ID first (TASK-986 W1). Before that, Global was
   * recognised only by its `key` being `__GLOBAL__` — and `key` is writable
   * through this very service's PATCH, so renaming the row permanently
   * disarmed the guard for it. The case-insensitive key check is KEPT beside
   * the id check as defence in depth (a reserved key on any other row is
   * treated as reserved too).
   *
   * This is a 403, not the 404-over-403 cross-tenant posture: the existence of
   * these two rows is not a secret — both ids are declared constants.
   *
   * @param action - Verb phrase for the message, so `update()` does not have
   *   to claim the caller tried to suspend anything.
   */
  private assertNotSystemTenant(tenant: TenantEntity, action = 'suspended, archived, or deleted'): void {
    const isGlobalKey = (tenant.key ?? '').toUpperCase() === GLOBAL_TENANT_KEY.toUpperCase();
    if (isGlobalKey || tenant.id === SYSTEM_TENANT_ID || tenant.id === SEED_TENANT_ID) {
      throw new ForbiddenException(`The system tenant cannot be ${action}.`);
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

    // TASK-890 §3.15 (OD-P) — the SAME platform-tier boundary
    // `GlobalSettingService.assertPlatformTierWrite` declares, on the FIFTH
    // write path to a `GlobalSetting` row. Without it this route was the way
    // around that guard, and the chain was entirely mundane: the controller's
    // scope check only 404s a UUID identifier that is not the caller's, so the
    // KEY `__SYSTEM__` walks past it; `GlobalSetting` is a SYSTEM-shared READ
    // model, so a tenant admin's `findById` resolves a platform row; the
    // ownership check compares the row to the NAMED tenant, not to the caller;
    // and the write goes through the UNSCOPED base client, which re-widens
    // nothing because it never narrowed. `locked` stopped 5 of the 37 seeded
    // SYSTEM rows and nothing stopped the other 32.
    //
    // A 403, not a 404, for the reason the sibling guard gives: the caller may
    // legitimately READ these rows — they are the defaults serving its own
    // tenant — so there is nothing to hide. A FOREIGN CUSTOMER tenant's row is
    // a different case and is still invisible (the read extension widens to
    // [caller, SYSTEM] only, so `findById` returns null and the caller gets the
    // existing not-found), which keeps 404-over-403 intact for cross-tenant.
    if (tenant.id === SYSTEM_TENANT_ID && !isSuperAdmin) {
      throw new ForbiddenException(`Platform-wide settings are managed by ${SUPER_ADMIN_ROLE} users only.`);
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
   *   - storageUsedBytes = SUM(Media.size)
   *   - storageQuotaBytes = SUM(TenantBucket.quotaBytes) over configured
   *                          buckets, else null ("no quota configured")
   *   - transcriptionMinutes = SUM(AudioRecording.duration ms)/60000
   *   - summaries24h = COUNT(SummaryMeta WHERE generatedAt >= now-24h)
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
   * TASK-986 — run `work` with CLS bound to `tenantId`, restoring the caller's
   * binding afterwards.
   *
   * The tenant-scope Prisma extension reads CLS: with a working tenant set, a
   * super admin's CLS names tenant A while the row being written belongs to
   * tenant B, and an explicit `tenantId: B` is then refused as a mismatch. The
   * same rebind is what `create()` does for its provisioning steps and what
   * `EntitlementsLifecycleService.runForTenant` does for the sweep — the
   * difference is that this one restores, because the audit broadcast that
   * follows must still be attributed to the caller's context.
   */
  private async runForTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.clsService.get('tenantId');
    this.clsService.set('tenantId', tenantId);
    try {
      return await work();
    } finally {
      this.clsService.set('tenantId', previous);
    }
  }

  /**
   * TASK-986 (owner ruling D-7) — append a `TenantPlanHistory` segment for a
   * plan transition. Idempotent in the writer (re-recording the plan already in
   * force is a no-op), so callers do not have to pre-check.
   *
   * Best-effort by design: this runs AFTER the plan column is committed, so a
   * failure here must not turn a successful plan change into a 500. It is
   * logged instead — the repair is a re-record, not a rollback.
   */
  private async recordPlanChangeBestEffort(tenantId: string, plan: TenantPlan | null, changeReason: string): Promise<void> {
    try {
      await this.billing?.recordPlanChange(tenantId, plan, new Date(), changeReason);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to record the tenant plan change in TenantPlanHistory',
        tenantId,
        plan,
        changeReason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-986 (owner ruling D-7) — (re-)derive the primary system bucket's quota
   * from the tenant's plan. Previously called only at creation, which left an
   * upgraded tenant on its old storage ceiling. Best-effort for the same reason
   * as {@link recordPlanChangeBestEffort}.
   */
  private async applyPlanStorageQuotaBestEffort(tenantId: string, plan: TenantPlan | null): Promise<void> {
    try {
      await this.tenantBucketService.applyPlanStorageQuota(tenantId, plan);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to apply the plan storage quota',
        tenantId,
        plan,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
}
