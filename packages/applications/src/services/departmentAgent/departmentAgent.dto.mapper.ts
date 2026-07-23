import { DepartmentAgentEntity } from '@arcaai/domains';
import { DepartmentAgentResponse } from './dto';

export class DepartmentAgentDtoMapper {
  static toResponse(entity: DepartmentAgentEntity): DepartmentAgentResponse {
    return {
      id: entity.id,
      departmentId: entity.departmentId,
      name: entity.name,
      slug: entity.slug,
      description: entity.description ?? undefined,
      promptTemplateId: entity.promptTemplateId,
      pinnedVersionNumber: entity.pinnedVersionNumber ?? null,
      dnaStylePolicy: entity.dnaStylePolicy,
      harnessOverrides: (entity.harnessOverrides as Record<string, unknown>) ?? undefined,
      goldenSetId: entity.goldenSetId ?? undefined,
      isDefault: entity.isDefault,
      // Lineage is surfaced read-only; it is NEVER accepted on a request DTO.
      sourceAgentTemplateSlug: entity.sourceAgentTemplateSlug ?? null,
      templateLocked: entity.templateLocked,
      tags: entity.tags ?? [],
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: (entity.updatedAt ?? entity.createdAt).toISOString(),
      // Surface `_version` so SDK clients can echo it back via `If-Match`.
      version: entity.version,
    };
  }
}
