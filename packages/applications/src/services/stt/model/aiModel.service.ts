import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    AiModelRepository,
    AiModelFactory,
    ResourceType,
    SysEventType,
    AiModelDownloadStatus,
    ModelTaskType,
} from '@arcaai/domains';
import { IAiModelService } from './IAiModelService';
import {
    CreateModelRequest,
    UpdateModelRequest,
    ModelResponse,
    PaginatedModelResponse,
} from './dto';
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
     * Update an existing model
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

        // Apply updates
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
        if (dto.memorySizeMb !== undefined) existing.memorySizeMb = dto.memorySizeMb;
        if (dto.computeType !== undefined) existing.computeType = dto.computeType;
        if (dto.tags !== undefined) existing.tags = dto.tags;
        existing.updatedBy = userId ?? null;

        const updated = await this.aiModelRepository.update(id, existing);

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: updated.id,
            data: { slug: updated.slug, name: updated.name },
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
     * Get paginated list of models
     */
    async list(page: number = 1, limit: number = 20): Promise<PaginatedModelResponse> {
        const tenantId = this.tenantId;
        if (!tenantId) {
            throw new BadRequestException('Tenant ID is required');
        }

        const models = await this.aiModelRepository.findAll({
            filters: { tenantId } as any,
            page,
            limit,
            sort: [{ name: 'asc' }],
        });

        const total = await this.aiModelRepository.count({
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
        checksum?: string
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
