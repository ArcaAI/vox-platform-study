import { DocumentTemplateEntity, DocumentTemplateVersionEntity } from '@arcaai/domains';
import { DocumentTemplateResponse, DocumentTemplateVersionResponse } from './dto';
import type { ShapeChangeClassification } from './document-shape-diff';

export class DocumentTemplateDtoMapper {
  static toResponse(entity: DocumentTemplateEntity): DocumentTemplateResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      slug: entity.slug,
      name: entity.name,
      description: entity.description ?? null,
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

  static toVersionResponse(entity: DocumentTemplateVersionEntity, versionSkew?: ShapeChangeClassification): DocumentTemplateVersionResponse {
    return {
      id: entity.id,
      templateId: entity.templateId,
      versionNumber: entity.versionNumber,
      shape: (entity.shape ?? {}) as Record<string, unknown>,
      compiled: (entity.compiled ?? {}) as Record<string, unknown>,
      compilerVersion: entity.compilerVersion,
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
