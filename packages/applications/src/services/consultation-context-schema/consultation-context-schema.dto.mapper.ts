import { ConsultationContextSchemaEntity, ConsultationContextSchemaVersionEntity } from '@arcaai/domains';
import { ConsultationContextSchemaResponse, ConsultationContextSchemaVersionResponse } from './dto';
import type { DefinitionChangeClassification } from './definition-diff';

export class ConsultationContextSchemaDtoMapper {
  static toResponse(entity: ConsultationContextSchemaEntity): ConsultationContextSchemaResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      slug: entity.slug,
      name: entity.name,
      description: entity.description ?? null,
      scope: entity.scope,
      departmentId: entity.departmentId ?? null,
      status: entity.status,
      pinnedVersionNumber: entity.pinnedVersionNumber ?? null,
      isDefault: entity.isDefault,
      sourceTemplateSlug: entity.sourceTemplateSlug ?? null,
      templateLocked: entity.templateLocked,
      version: entity.version,
      createdAt: toIso(entity.createdAt),
      updatedAt: toIso(entity.updatedAt),
    };
  }

  static toVersionResponse(
    entity: ConsultationContextSchemaVersionEntity,
    versionSkew?: DefinitionChangeClassification,
  ): ConsultationContextSchemaVersionResponse {
    return {
      id: entity.id,
      schemaId: entity.schemaId,
      versionNumber: entity.versionNumber,
      definition: (entity.definition ?? {}) as Record<string, unknown>,
      checksum: entity.checksum,
      changeReason: entity.changeReason ?? null,
      createdBy: entity.createdBy ?? null,
      createdAt: toIso(entity.createdAt),
      versionSkew,
    };
  }
}

/**
 * Timestamps are ISO strings on the wire. Tolerates a plain object from a
 * hand-built test fixture, where `createdAt` may already be a string.
 */
function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date(0).toISOString();
}
