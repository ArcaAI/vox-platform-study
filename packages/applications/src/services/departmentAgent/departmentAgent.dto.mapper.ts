import { DepartmentAgentEntity, DepartmentAgentVersionEntity } from '@arcaai/domains';
import { DepartmentAgentResponse, DepartmentAgentVersionResponse } from './dto';

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
      // TASK-635 RF-4 — mapped as explicit `null` (not `undefined`) so a client
      // can tell "no binding configured" apart from "field absent from this API
      // version"; the console renders them as empty selects.
      newPatientTemplateId: entity.newPatientTemplateId ?? null,
      revisitTemplateId: entity.revisitTemplateId ?? null,
      preSummaryTemplateId: entity.preSummaryTemplateId ?? null,
      livePromptTemplateId: entity.livePromptTemplateId ?? null,
      toolConfig: (entity.toolConfig as Record<string, unknown>) ?? null,
      llmOverrides: (entity.llmOverrides as Record<string, unknown>) ?? null,
      isDefault: entity.isDefault,
      // Lineage is surfaced read-only; it is NEVER accepted on a request DTO.
      sourceAgentTemplateSlug: entity.sourceAgentTemplateSlug ?? null,
      templateLocked: entity.templateLocked,
      tags: entity.tags ?? [],
      // TASK-659 loop configuration + promotion surface.
      role: entity.role,
      subscribedKinds: (entity.subscribedKinds as Record<string, unknown>) ?? null,
      writeScope: (entity.writeScope as Record<string, unknown>) ?? null,
      goal: (entity.goal as Record<string, unknown>) ?? null,
      guardrailProfile: entity.guardrailProfile ?? null,
      alwaysActions: entity.alwaysActions ?? null,
      neverActions: entity.neverActions ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: (entity.updatedAt ?? entity.createdAt).toISOString(),
      // Surface `_version` so SDK clients can echo it back via `If-Match`.
      version: entity.version,
    };
  }

  /** TASK-674 — one immutable `DepartmentAgentVersion` snapshot, read-only. */
  static toVersionResponse(entity: DepartmentAgentVersionEntity): DepartmentAgentVersionResponse {
    return {
      id: entity.id,
      agentId: entity.agentId,
      versionNumber: entity.versionNumber,
      configSnapshot: (entity.configSnapshot ?? {}) as Record<string, unknown>,
      checksum: entity.checksum,
      changeReason: entity.changeReason ?? null,
      createdBy: entity.createdBy ?? null,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
