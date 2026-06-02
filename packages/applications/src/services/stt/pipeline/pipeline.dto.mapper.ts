import { AsrPipelineEntity, AsrPipelineVersionEntity } from '@arcaai/domains';
import { PipelineResponse, PipelineVersionResponse } from './dto';

export class PipelineDtoMapper {
  static toResponse(entity: AsrPipelineEntity): PipelineResponse {
    return {
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      description: entity.description,
      configYaml: entity.configYaml,
      resourceStatus: entity.resourceStatus,
      // TASK-328 A6 — tenant default flag.
      isDefault: entity.isDefault ?? false,
      tags: entity.tags || [],
      tenantId: entity.tenantId || '',
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      createdBy: entity.createdBy,
      updatedBy: entity.updatedBy,
      // TASK-302 Stream D Phase E.4 — round-trip the OCC token so the
      // SDK / UI can echo it as `If-Match` on the next PATCH.
      version: entity.version,
    };
  }

  // TASK-328 A6 — map a snapshot entity to its response shape.
  static toVersionResponse(entity: AsrPipelineVersionEntity): PipelineVersionResponse {
    return {
      id: entity.id,
      asrPipelineId: entity.asrPipelineId,
      versionNumber: entity.versionNumber,
      configYaml: entity.configYaml,
      name: entity.name ?? null,
      description: entity.description ?? null,
      changeReason: entity.changeReason ?? null,
      changedBy: entity.changedBy ?? null,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
