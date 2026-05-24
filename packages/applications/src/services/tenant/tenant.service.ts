import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
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
   * Fetches a tenant by ID
   * @param id - The tenant ID
   * @returns Promise resolving to the tenant entity
   */
  async fetchById(id: EntityId): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: tenant.id,
      data: tenant.toObject() as object,
    });
    return tenant;
  }

  /**
   * Fetches tenants by code name
   * @param props - Query parameters including code name, pagination and search
   * @returns Promise resolving to paginated tenant response
   */
  async fetchByCodeName(codeName: string): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findFirst({
      where: {
        key: codeName,
      },
    });
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
   * @param request - The update request containing changes
   * @returns Promise resolving to the updated tenant
   * @throws ArgumentInvalidException if no changes are detected
   */
  async update(id: EntityId, request: UpdateTenantRequest): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findById(id);

    const previousData = tenant.toObject();
    this.updateEntity(tenant, request);

    if (!tenant.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedTenant = await this.tenantRepository.update(id, tenant);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedTenant.id,
      data: tenant.changes,
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

    const updatedConfigs: GlobalSettingEntity[] = [];

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

      if (!existingConfig.hasChanges) {
        updatedConfigs.push(existingConfig);
        continue;
      }

      // TASK-302 Stream D Phase C (C.3) — Compare-And-Set against `_version`.
      // The `OptimisticConcurrencyException` propagates straight out so the
      // HTTP layer (Phase D ExceptionFilter) can render `412 Precondition
      // Failed` with `{ currentVersion, yourVersion }`. The transaction
      // wrapper added in C.4 turns the multi-row case into all-or-nothing.
      const updatedConfig = await this.globalSettingRepository.updateWithVersion(
        existingConfig.id,
        existingConfig,
        config.expectedVersion,
      );

      if (!updatedConfig) {
        throw new InternalServerErrorException(`Failed to update GlobalSettingEntity with id: ${config.id}`);
      }

      updatedConfigs.push(updatedConfig);
    }

    // Phase 0 Item 4 (TASK-302 Stream A) — scrub @Secret fields when locked.
    // Per-entity decision: a mixed batch emits a partially-scrubbed array.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceIds: updatedConfigs.map((config) => config.id),
      data: updatedConfigs.map((config) => scrubLockedForAudit(config)),
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
