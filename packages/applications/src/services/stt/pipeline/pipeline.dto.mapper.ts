import { AsrPipelineEntity } from '@arcaai/domains';
import { PipelineResponse } from './dto';

export class PipelineDtoMapper {
  static toResponse(entity: AsrPipelineEntity): PipelineResponse {
    return {
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      description: entity.description,
      configYaml: entity.configYaml,
      resourceStatus: entity.resourceStatus,
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
}
