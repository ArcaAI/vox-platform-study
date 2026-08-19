import { WorkflowAssignmentEntity } from '@arcaai/domains';
import { WorkflowAssignmentResponse } from './dto';

export class WorkflowAssignmentDtoMapper {
  static toResponse(entity: WorkflowAssignmentEntity): WorkflowAssignmentResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      scope: entity.scope,
      scopeId: entity.scopeId ?? null,
      paletteKey: entity.paletteKey,
      workflowDefinitionSlug: entity.workflowDefinitionSlug,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }
}
