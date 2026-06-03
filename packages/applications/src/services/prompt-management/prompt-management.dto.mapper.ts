import { PromptTemplateEntity, PromptVersionEntity } from '@arcaai/domains';
import { PromptTemplateResponse } from './dto/prompt-template.response';
import { PromptVersionResponse } from './dto/prompt-version.response';

export class PromptManagementDtoMapper {
  static toTemplateResponse(entity: PromptTemplateEntity): PromptTemplateResponse {
    return {
      id: entity.id,
      name: entity.name ?? '',
      description: entity.description ?? undefined,
      content: entity.content ?? '',
      category: entity.category ?? '',
      // TASK-331 doc-02 F5 — surface the real status; pre-migration rows default DRAFT.
      status: (entity.status as 'DRAFT' | 'PUBLISHED') ?? 'DRAFT',
      variables: entity.variables ?? undefined,
      currentVersionNumber: entity.currentVersionNumber ?? 1,
      departmentId: entity.departmentId ?? undefined,
      tags: entity.tags ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      resourceStatus: entity.resourceStatus ?? undefined,
      // TASK-302 Stream D Phase E.3 — surface `_version` (the OCC token,
      // distinct from `currentVersionNumber`) so SDK clients can echo
      // it back via `If-Match: "<version>"` on the next PATCH.
      version: entity.version,
    };
  }

  static toVersionResponse(entity: PromptVersionEntity): PromptVersionResponse {
    return {
      id: entity.id,
      promptTemplateId: entity.promptTemplateId ?? '',
      versionNumber: entity.versionNumber ?? 0,
      content: entity.content ?? '',
      variables: entity.variables ?? undefined,
      changeReason: entity.changeReason ?? undefined,
      changedBy: entity.changedBy ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
