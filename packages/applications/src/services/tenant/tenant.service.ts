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
  PromptTemplateRepository,
  AsrPipelineRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { ITenantService } from './ITenantService';
import { CreateTenantRequest, UpdateTenantRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UpdateTenantConfigRequest } from './dto/updateTenantConfigRequest';
import { ITenantBucketService } from '../tenant-bucket/ITenantBucketService';
import { GLOBAL_TENANT_KEY, SUPER_ADMIN_ROLE, isUuidIdentifier } from './constants';
import { scrubLockedForAudit } from './scrubbing';

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
    const newTenant = TenantFactory.CreateTenant({
      ...request,
      createdBy: this.requestUser?.id,
    });

    const tenant = await this.tenantRepository.create(newTenant);

    if (!tenant) {
      throw new InternalServerErrorException(`Failed to create TenantEntity: ${request}`);
    }

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
      await this.provisionTenantConfigs(tenant.id);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to provision tenant configurations for new tenant',
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return tenant;
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
   *    (e.g. `default-stt-model`, `smr-provider-models`) remain locked on the
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const tenants = await this.tenantRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.tenantRepository.count(withFormattedCountProps(props));

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { codeName, limit, page, search } = props;
    const tenants = await this.tenantRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        key: codeName,
      },
    });
    const count = await this.tenantRepository.count({
      ...withFormattedCountProps(props),
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const tenants = await this.tenantRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.tenantRepository.count({
      ...withFormattedCountProps(props),
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
   * TASK-306 P1.3 (audit H-3 / NEW-6 / AC-3) — short-circuits with
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
   * TASK-306 P1.3 (audit H-3 / NEW-6 / AC-3) — mirrors the `fetchById`
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
   *   TASK-302 Stream D Phase E.1 / `UpdateTenantRequest`).
   * @returns Promise resolving to the updated tenant
   * @throws ArgumentInvalidException if no changes are detected
   * @throws OptimisticConcurrencyException if the row's `_version` drifted
   *   under us (CAS predicate matched zero rows). The HTTP layer renders
   *   this as `412 Precondition Failed` via the Phase D ExceptionFilter.
   *
   * @see TASK-302 Stream D Phase E.1 — Tenant OCC migration
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

    if (!tenant.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // Snapshot the row's pre-write version BEFORE the CAS bumps it. After
    // `updateWithVersion` returns, `tenant.version` (round-tripped from the
    // DB) will already be the new version. Mirrors the pattern used by
    // `updateTenantConfigs` after C.8.
    const previousVersion = tenant.version;

    // TASK-302 Stream D Phase E.1 — Compare-And-Set against `_version`.
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
        // change with the row's prior state (same shape as C.8).
        previousVersion,
        newVersion: updatedTenant.version,
      },
      previousData,
    });
    return updatedTenant;
  }

  /**
   * Soft deletes a tenant by ID
   * @param id - The tenant ID
   * @returns Promise resolving to the deleted tenant
   */
  async deleteById(id: EntityId): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: tenant.id,
      data: tenant.toObject() as object,
    });
    return tenant;
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

    // TASK-306 P2.2 (audit H-1 / AC-4) — caller-identity check. Non-SUPER_ADMIN
    // callers are restricted to their CLS tenant; cross-tenant reads (including
    // codeName lookups that resolve to another tenant) short-circuit with
    // `NotFoundException` so the API does not leak the existence of foreign
    // tenants' config rows. SUPER_ADMIN retains the cross-tenant bypass for
    // admin UI tenant pickers + platform-metadata flows (mirrors the W5.1.3
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

    // TASK-302 Stream D Phase C (C.4) — all-or-nothing via Prisma's
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
    // TASK-302 Stream D Phase C (C.8) — snapshot each row's `_version`
    // BEFORE the CAS so the post-write audit-log SysEvent can carry the
    // exact transition (previousVersion -> newVersion). Investigators then
    // reconstruct history via `metadata->>'newVersion'` without re-deriving
    // from timestamps (Research §7). Index aligns with `results` below.
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
          await this.validateSmrConfigValue(existingConfig.key, config.value, tenant.id);
        }

        // Phase 0 Item 2 (TASK-302 Stream A) — explicit allowlist.
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

        // C.8 — snapshot the pre-write version BEFORE the CAS bumps the
        // entity's `_version`. The repo round-trips the bumped version,
        // so reading `existingConfig.version` AFTER the CAS would emit
        // `previousVersion === newVersion` and break audit correlation.
        const previousVersion = existingConfig.version;

        if (!existingConfig.hasChanges) {
          results.push(existingConfig);
          previousVersions.push(previousVersion);
          continue;
        }

        // TASK-302 Stream D Phase C (C.3) — Compare-And-Set against `_version`.
        // The `OptimisticConcurrencyException` propagates straight out of
        // the callback, aborting the outer `$transaction` (C.4 atomicity).
        // The HTTP layer (Phase D ExceptionFilter) renders `412 Precondition
        // Failed` with `{ currentVersion, yourVersion }`.
        const updatedConfig = await this.globalSettingRepository.updateWithVersion(
          existingConfig.id,
          existingConfig,
          config.expectedVersion,
          tx,
        );

        if (!updatedConfig) {
          throw new InternalServerErrorException(`Failed to update GlobalSettingEntity with id: ${config.id}`);
        }

        results.push(updatedConfig);
        previousVersions.push(previousVersion);
      }
      return results;
    });

    // Phase 0 Item 4 (TASK-302 Stream A) — scrub @Secret fields when locked.
    // Per-entity decision: a mixed batch emits a partially-scrubbed array.
    // C.4 — broadcast lives OUTSIDE the transaction so a rolled-back batch
    // produces no `Resource.Updated` audit entry.
    // C.8 — carry the per-row version transition so audit consumers can
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
   * Get usage statistics for a tenant
   * @param tenantId - The tenant ID
   * @returns Usage stats: totalUsers, totalDepartments, totalPromptTemplates, totalPipelines
   */
  async getUsageStats(tenantId: EntityId): Promise<{
    totalUsers: number;
    totalDepartments: number;
    totalPromptTemplates: number;
    totalPipelines: number;
  }> {
    await this.tenantRepository.findById(tenantId);

    const [distinctUserAssignments, totalDepartments, totalPromptTemplates, totalPipelines] = await Promise.all([
      this.databaseService.client.userRoleAssignment.findMany({
        where: { tenantId },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.departmentRepository.count({ where: { tenantId } }),
      this.promptTemplateRepository.count({ where: { tenantId } }),
      this.asrPipelineRepository.count({ where: { tenantId } }),
    ]);

    return {
      totalUsers: distinctUserAssignments.length,
      totalDepartments,
      totalPromptTemplates,
      totalPipelines,
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

  private async validateSmrConfigValue(settingKey: string, newValue: string, tenantId: string): Promise<void> {
    const SMR_PROVIDER_KEY = 'default-smr-provider';
    const SMR_MODEL_KEY = 'default-smr-model';

    if (settingKey !== SMR_PROVIDER_KEY && settingKey !== SMR_MODEL_KEY) {
      return;
    }

    const catalog = await this.loadSmrCatalog(tenantId);
    if (!catalog || catalog.length === 0) {
      return;
    }

    if (settingKey === SMR_PROVIDER_KEY) {
      const validProviders = catalog.map((entry: { provider: string }) => entry.provider);
      if (!validProviders.includes(newValue)) {
        throw new ArgumentInvalidException(`'${newValue}' is not a valid SMR provider. ` + `Available: ${validProviders.join(', ')}`);
      }
    }

    if (settingKey === SMR_MODEL_KEY) {
      const currentProvider = await this.getCurrentSmrProvider(tenantId);
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

  private async loadSmrCatalog(tenantId: string): Promise<{ provider: string; models: { name: string; size: string }[] }[] | null> {
    const settings = await this.globalSettingRepository.findAll({
      where: {
        tenantId,
        key: 'smr-provider-models',
      },
    });

    const catalogSetting = settings.find((s: GlobalSettingEntity) => s.key === 'smr-provider-models');
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

  private async getCurrentSmrProvider(tenantId: string): Promise<string> {
    const settings = await this.globalSettingRepository.findAll({
      where: {
        tenantId,
        key: 'default-smr-provider',
      },
    });

    const providerSetting = settings.find((s: GlobalSettingEntity) => s.key === 'default-smr-provider');
    return providerSetting?.value?.trim() || 'ollama';
  }
}
