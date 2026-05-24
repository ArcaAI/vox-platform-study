import { DepartmentEntity } from '@arcaai/domains';
import { DepartmentResponse } from './dto';

export class DepartmentDtoMapper {
  static toResponse(entity: DepartmentEntity): DepartmentResponse {
    return {
      id: entity.id,
      code: entity.code ?? undefined,
      name: entity.name ?? undefined,
      description: entity.description ?? undefined,
      parentDepartmentId: entity.parentDepartmentId ?? undefined,
      isRootDepartment: entity.isRootDepartment,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      defaultSummaryTemplate: entity.defaultSummaryTemplate ?? undefined,
      preSummaryPromptId: entity.preSummaryPromptId ?? undefined,
      newPatientPromptId: entity.newPatientPromptId ?? undefined,
      revisitPromptId: entity.revisitPromptId ?? undefined,
      promptConfig: (entity.promptConfig as Record<string, unknown>) ?? undefined,
      resourceStatus: entity.resourceStatus ?? undefined,
      // TASK-302 Stream D Phase E.2 — surface `_version` so SDK clients
      // can echo it back via `If-Match: "<version>"` (or body-field
      // `expectedVersion`) on the next PATCH.
      version: entity.version,
    };
  }
}
