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
      variables: entity.variables ?? undefined,
      currentVersionNumber: entity.currentVersionNumber ?? 1,
      departmentId: entity.departmentId ?? undefined,
      tags: entity.tags ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      resourceStatus: entity.resourceStatus ?? undefined,
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
