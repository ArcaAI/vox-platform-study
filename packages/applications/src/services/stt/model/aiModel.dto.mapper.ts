import { AiModelEntity } from '@arcaai/domains';
import { ModelResponse } from './dto';

export class AiModelDtoMapper {
    static toResponse(entity: AiModelEntity): ModelResponse {
        return {
            id: entity.id,
            name: entity.name,
            slug: entity.slug,
            description: entity.description,
            category: entity.category,
            taskType: entity.taskType,
            modelType: entity.modelType,
            source: entity.source,
            sourceUri: entity.sourceUri,
            sourceRevision: entity.sourceRevision,
            format: entity.format,
            memorySizeMb: entity.memorySizeMb,
            computeType: entity.computeType,
            downloadStatus: entity.downloadStatus,
            localPath: entity.localPath,
            downloadedAt: entity.downloadedAt,
            fileSizeMb: entity.fileSizeMb,
            checksum: entity.checksum,
            resourceStatus: entity.resourceStatus,
            tags: entity.tags || [],
            tenantId: entity.tenantId || '',
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
            createdBy: entity.createdBy,
            updatedBy: entity.updatedBy,
        };
    }
}
