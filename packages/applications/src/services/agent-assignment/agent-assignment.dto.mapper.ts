import { AgentAssignmentEntity } from '@arcaai/domains';
import { AgentAssignmentResponse } from './dto';

export class AgentAssignmentDtoMapper {
  static toResponse(entity: AgentAssignmentEntity): AgentAssignmentResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      scope: entity.scope,
      scopeId: entity.scopeId ?? null,
      task: entity.task,
      agentSlug: entity.agentSlug,
      selectorTags: entity.selectorKey ? entity.selectorKey.split(',') : [],
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
