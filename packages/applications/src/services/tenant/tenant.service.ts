import { Inject, Injectable, Logger } from '@nestjs/common';
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
    PromptTemplateRepository,
    AsrPipelineRepository,
    UserRoleAssignmentRepository
} from '@arcaai/domains';
import {
    InternalServerErrorException,
    ArgumentInvalidException
} from '@arcaai/exceptions';
import { ITenantService } from './ITenantService';
import { CreateTenantRequest, UpdateTenantRequest } from './dto';
import {
    BaseService,
    FetchResponse,
    PaginatedQuery,
    withFormattedPaginatedProps,
    withFormattedCountProps
} from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { UpdateTenantConfigRequest } from './dto/updateTenantConfigRequest';
import { ITenantBucketService } from '../tenant-bucket/ITenantBucketService';

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
        protected override readonly clsService: ClsService<IActiveUserContext>
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
            createdBy: this.requestUser?.id
        });

        const tenant = await this.tenantRepository.create(newTenant);

        if (!tenant) {
            throw new InternalServerErrorException(
                `Failed to create TenantEntity: ${request}`
            );
        }

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
            resourceId: tenant.id,
            createdAt: tenant.createdAt,
            data: tenant.toObject() as object
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

        return tenant;
    }

    /**
     * Fetches all tenants with pagination
     * @param props - Query parameters for pagination and search
     * @returns Promise resolving to paginated tenant response
     */
    async fetchAll(
        props: PaginatedQuery
    ): Promise<FetchResponse<TenantEntity>> {
        const { limit, page, search } = props;
        const tenants = await this.tenantRepository.findAll(
            withFormattedPaginatedProps(props)
        );

        const count = await this.tenantRepository.count(
            withFormattedCountProps(props)
        );

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                items: tenants.map((tenant: TenantEntity) => tenant.id)
            }
        });
        return new FetchResponse<TenantEntity>({
            data: tenants,
            count,
            limit,
            page
        });
    }

    /**
     * Fetches all tenants by code name
     * @param props - Query parameters including code name, pagination and search
     * @returns Promise resolving to paginated tenant response
     */
    async fetchAllByTenantCodeName(
        props: PaginatedQuery & { codeName: string }
    ): Promise<FetchResponse<TenantEntity>> {
        const { codeName, limit, page, search } = props;
        const tenants = await this.tenantRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                key: codeName
            }
        });
        const count = await this.tenantRepository.count({
            ...withFormattedCountProps(props),
            where: {
                key: codeName
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                key: codeName,
                items: tenants.map((tenant: TenantEntity) => tenant.id)
            }
        });
        return new FetchResponse<TenantEntity>({
            data: tenants,
            count,
            limit,
            page
        });
    }

    /**
     * Fetches all tenants created by a specific user
     * @param props - Query parameters including user ID, pagination and search
     * @returns Promise resolving to paginated tenant response
     */
    async fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<TenantEntity>> {
        const { userId, limit, page, search } = props;
        const tenants = await this.tenantRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                createdBy: userId
            }
        });
        const count = await this.tenantRepository.count({
            ...withFormattedCountProps(props),
            where: {
                createdBy: userId
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                createdBy: userId,
                items: tenants.map((tenant: TenantEntity) => tenant.id)
            }
        });
        return new FetchResponse<TenantEntity>({
            data: tenants,
            count,
            limit,
            page
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
            data: tenant.toObject() as object
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
                key: codeName
            }
        });
        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                key: codeName,
                id: tenant.id
            }
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
    async update(
        id: EntityId,
        request: UpdateTenantRequest
    ): Promise<TenantEntity> {
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
            previousData
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
            data: tenant.toObject() as object
        });
        return tenant;
    }

    /**
     * Tenant configuration methods
     */

    /**
     * Fetches configurations for a specific tenant
     * @param props - Query parameters including tenant ID, pagination
     * @returns Promise resolving to paginated configuration response
     * @throws ArgumentInvalidException if tenant not found
     */
    async fetchTenantConfigs(
        props: PaginatedQuery & { tenantId?: string; codeName?: string }
    ): Promise<FetchResponse<GlobalSettingEntity>> {
        const { limit, page, tenantId, codeName } = props;

        if (!tenantId && !props.codeName) {
            throw new ArgumentInvalidException(
                'Tenant ID or Tenant Code is required'
            );
        }

        const tenant = await this.tenantRepository.findFirst({
            where: {
                OR: [{ id: tenantId }, { key: codeName }]
            }
        });

        if (!tenant) {
            throw new ArgumentInvalidException('Tenant not found');
        }

        const paginatedProps = withFormattedPaginatedProps(props);
        const countProps = withFormattedCountProps(props);

        const tenantWhere = { tenantId: tenant.id };

        const [configs, count] = await Promise.all([
            this.globalSettingRepository.findAll({
                ...paginatedProps,
                where: { ...paginatedProps.where, ...tenantWhere }
            }),
            this.globalSettingRepository.count({
                ...countProps,
                where: { ...countProps.where, ...tenantWhere }
            }),
        ]);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                tenantId: tenant.id,
                items: configs.map((config) => config.id)
            }
        });

        return new FetchResponse<GlobalSettingEntity>({
            data: configs,
            count,
            limit,
            page
        });
    }

    /**
     * Updates configurations for a specific tenant
     * @param identifier - The tenant ID or code name
     * @param configs - Array of configuration entities to update
     * @returns Promise resolving to array of updated configurations
     * @throws ArgumentInvalidException if tenant not found or configs invalid
     * @throws InternalServerErrorException if update fails
     */
    async updateTenantConfigs(
        identifier: EntityId | string,
        request: UpdateTenantConfigRequest[]
    ): Promise<FetchResponse<GlobalSettingEntity>> {
        const tenant = await this.tenantRepository.findFirst({
            where: {
                OR: [{ id: identifier }, { key: identifier }]
            }
        });

        if (!tenant) {
            throw new ArgumentInvalidException('Tenant not found');
        }

        const updatedConfigs: GlobalSettingEntity[] = [];

        for (const config of request) {
            const existingConfig = await this.globalSettingRepository.findById(
                config.id
            );

            if (!existingConfig) {
                throw new ArgumentInvalidException(
                    `Config with id ${config.id} not found`
                );
            }

            if (existingConfig.tenantId !== tenant.id) {
                throw new ArgumentInvalidException(
                    `Config ${config.id} does not belong to tenant ${tenant.id}`
                );
            }

            if (config.value !== undefined) {
                await this.validateSmrConfigValue(
                    existingConfig.key,
                    config.value,
                    tenant.id
                );
            }

            const { id: _id, ...changes } = config;
            this.updateEntity(existingConfig, changes);

            if (!existingConfig.hasChanges) {
                updatedConfigs.push(existingConfig);
                continue;
            }

            const updatedConfig =
                await this.globalSettingRepository.update(
                    existingConfig.id,
                    existingConfig
                );

            if (!updatedConfig) {
                throw new InternalServerErrorException(
                    `Failed to update GlobalSettingEntity with id: ${config.id}`
                );
            }

            updatedConfigs.push(updatedConfig);
        }

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceIds: updatedConfigs.map((config) => config.id),
            data: updatedConfigs.map((config) => config.toObject())
        });

        return new FetchResponse<GlobalSettingEntity>({
            data: updatedConfigs,
            count: updatedConfigs.length,
            limit: 0,
            page: 0
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

        const [distinctUserAssignments, totalDepartments, totalPromptTemplates, totalPipelines] =
            await Promise.all([
                this.databaseService.client.userRoleAssignment.findMany({
                    where: { tenantId },
                    select: { userId: true },
                    distinct: ['userId']
                }),
                this.departmentRepository.count({ where: { tenantId } }),
                this.promptTemplateRepository.count({ where: { tenantId } }),
                this.asrPipelineRepository.count({ where: { tenantId } })
            ]);

        return {
            totalUsers: distinctUserAssignments.length,
            totalDepartments,
            totalPromptTemplates,
            totalPipelines
        };
    }

    private async validateSmrConfigValue(
        settingKey: string,
        newValue: string,
        tenantId: string
    ): Promise<void> {
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
            const validProviders = catalog.map(
                (entry: { provider: string }) => entry.provider
            );
            if (!validProviders.includes(newValue)) {
                throw new ArgumentInvalidException(
                    `'${newValue}' is not a valid SMR provider. ` +
                    `Available: ${validProviders.join(', ')}`
                );
            }
        }

        if (settingKey === SMR_MODEL_KEY) {
            const currentProvider = await this.getCurrentSmrProvider(tenantId);
            const providerEntry = catalog.find(
                (entry: { provider: string }) => entry.provider === currentProvider
            );
            if (providerEntry) {
                const validModels = providerEntry.models.map(
                    (m: { name: string }) => m.name
                );
                if (!validModels.includes(newValue)) {
                    throw new ArgumentInvalidException(
                        `'${newValue}' is not a valid model for provider '${currentProvider}'. ` +
                        `Available: ${validModels.join(', ')}`
                    );
                }
            }
        }
    }

    private async loadSmrCatalog(
        tenantId: string
    ): Promise<{ provider: string; models: { name: string; size: string }[] }[] | null> {
        const settings = await this.globalSettingRepository.findAll({
            where: {
                tenantId,
                key: 'smr-provider-models'
            }
        });

        const catalogSetting = settings.find(
            (s: GlobalSettingEntity) => s.key === 'smr-provider-models'
        );
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
                key: 'default-smr-provider'
            }
        });

        const providerSetting = settings.find(
            (s: GlobalSettingEntity) => s.key === 'default-smr-provider'
        );
        return providerSetting?.value?.trim() || 'ollama';
    }
}
