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
      // Tenant default flag.
      isDefault: entity.isDefault ?? false,
      // Template lineage (drives the console's Template badge and
      // read-only detail state).
      sourceTemplateSlug: entity.sourceTemplateSlug ?? null,
      templateLocked: entity.templateLocked ?? false,
      tags: entity.tags || [],
      tenantId: entity.tenantId || '',
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      createdBy: entity.createdBy,
      updatedBy: entity.updatedBy,
      // Round-trip the OCC token so the
      // SDK / UI can echo it as `If-Match` on the next PATCH.
      version: entity.version,
    };
  }

  // Map a snapshot entity to its response shape.
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
