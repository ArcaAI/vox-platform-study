import { AiModelEntity, AiTaskDefaultEntity } from '@arcaai/domains';
import { AiTaskDefaultResponse, AiTaskModelSummary } from './dto';

export class AiTaskDefaultDtoMapper {
  static toResponse(entity: AiTaskDefaultEntity): AiTaskDefaultResponse {
    return {
      tenantId: entity.tenantId,
      taskKey: entity.taskKey,
      modelSlug: entity.modelSlug,
      configJson: entity.configJson ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }

  /**
   * Placeholder for a (tenant, taskKey) with no row yet: version 0. The client
   * GETs this, then PUTs with `expectedVersion: 0` (`If-Match: "0"`) to create
   * the row (mirrors `TenantTtsConfigDtoMapper.placeholder`).
   */
  static placeholder(tenantId: string, taskKey: string): AiTaskDefaultResponse {
    return {
      tenantId,
      taskKey,
      modelSlug: null,
      configJson: null,
      version: 0,
    };
  }

  static toModelSummary(model: AiModelEntity): AiTaskModelSummary {
    return {
      id: model.id,
      slug: model.slug,
      name: model.name,
      provider: model.provider ?? null,
      architecture: model.architecture ?? null,
      taskType: model.taskType,
      format: model.format,
      sourceUri: model.sourceUri,
    };
  }
}
