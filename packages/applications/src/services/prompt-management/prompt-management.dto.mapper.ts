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
      // Expose scope for the doctor "My Prompts" UI.
      scope: entity.scope ?? undefined,
      // Surface the real status; pre-migration rows default DRAFT.
      status: (entity.status as 'DRAFT' | 'PUBLISHED' | 'APPROVED') ?? 'DRAFT',
      variables: entity.variables ?? undefined,
      currentVersionNumber: entity.currentVersionNumber ?? 1,
      // The snapshot resolution actually serves. Without it the console cannot
      // distinguish "approved and running v3" from "edited to v5 since".
      approvedVersionNumber: entity.approvedVersionNumber ?? null,
      departmentId: entity.departmentId ?? undefined,
      tags: entity.tags ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      resourceStatus: entity.resourceStatus ?? undefined,
      // Last prompt-test outcome for the Agent Jobs surface.
      // Vault-encrypted `lastTestOutput` intentionally omitted.
      lastTestScore: entity.lastTestScore ?? undefined,
      lastTestAt: entity.lastTestAt ? entity.lastTestAt.toISOString() : undefined,
      // Surface `_version` (the OCC token,
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
