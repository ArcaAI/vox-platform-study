import { AiModelEntity } from '@arcaai/domains';
import { ModelResponse } from './dto';
import { MODEL_TASK_TYPE_TO_PIPELINE_TAG, deriveLocalPath } from './constants';

export class AiModelDtoMapper {
  static toResponse(entity: AiModelEntity): ModelResponse {
    return {
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      description: entity.description,
      category: entity.category,
      taskType: entity.taskType,
      pipelineTag: MODEL_TASK_TYPE_TO_PIPELINE_TAG[entity.taskType] ?? 'other',
      modelType: entity.modelType,
      source: entity.source,
      sourceUri: entity.sourceUri,
      sourceRevision: entity.sourceRevision,
      format: entity.format,
      libraryName: entity.libraryName,
      servedBy: entity.servedBy,
      deploymentKind: entity.deploymentKind,
      wireModelId: entity.wireModelId ?? null,
      license: entity.license ?? null,
      gated: entity.gated,
      baseModel: entity.baseModel ?? null,
      languages: entity.languages ?? [],
      hfRevision: entity.hfRevision ?? null,
      bucketPrefix: entity.bucketPrefix ?? null,
      primaryObject: entity.primaryObject ?? null,
      manifestDigest: entity.manifestDigest ?? null,
      availability: entity.availability,
      availabilityCheckedAt: entity.availabilityCheckedAt ?? null,
      availabilityDetail: entity.availabilityDetail ?? null,
      isPlatformDefaultFor: entity.isPlatformDefaultFor ?? [],
      provider: entity.provider ?? null,
      architecture: entity.architecture ?? null,
      memorySizeMb: entity.memorySizeMb,
      computeType: entity.computeType,
      downloadStatus: entity.downloadStatus,
      // DERIVED from the bucket identity (TASK-860 D-2); the stored column
      // only backs rows that predate `bucketPrefix`.
      localPath: entity.bucketPrefix ? deriveLocalPath(entity.bucketPrefix, entity.primaryObject) : (entity.localPath ?? null),
      downloadedAt: entity.downloadedAt,
      fileSizeMb: entity.fileSizeMb,
      checksum: entity.checksum,
      resourceStatus: entity.resourceStatus,
      version: entity.version,
      tags: entity.tags || [],
      tenantId: entity.tenantId || '',
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      createdBy: entity.createdBy,
      updatedBy: entity.updatedBy,
    };
  }
}
