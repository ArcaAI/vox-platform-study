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
    };
  }
}
