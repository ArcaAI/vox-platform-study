import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentTemplateStatus } from '@arcaai/domains';
import type { ShapeChangeClassification } from '../document-shape-diff';

export class DocumentTemplateResponse {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ enum: DocumentTemplateStatus }) status: DocumentTemplateStatus;
  @ApiPropertyOptional({ nullable: true, description: 'The version generation serves. Null until the first publish.' })
  pinnedVersionNumber: number | null;
  @ApiProperty() isDefault: boolean;
  @ApiPropertyOptional({ nullable: true }) sourceTemplateSlug: string | null;
  @ApiProperty() templateLocked: boolean;
  @ApiProperty({ description: 'Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor.' })
  version: number;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class DocumentTemplateVersionResponse {
  @ApiProperty() id: string;
  @ApiProperty() templateId: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The AUTHORED shape.' })
  shape: Record<string, unknown>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The DERIVED artifacts frozen with the shape: `responseFormat` (the strict json_schema a provider is decoded ' +
      'against), `checklist`, `sectionStates`, and `promptInstruction` for providers that ignore `response_format`.',
  })
  compiled: Record<string, unknown>;
  @ApiProperty({ description: 'Which compiler produced `compiled`.' }) compilerVersion: string;
  @ApiProperty({ description: 'sha256 over the canonical JSON of `shape`.' }) checksum: string;
  @ApiPropertyOptional({ nullable: true }) changeReason: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy: string | null;
  @ApiProperty() createdAt: string;
  /**
   * Whether a reader still pinned to THIS version would keep working against
   * the template's CURRENT pin. Set on every version except the currently
   * pinned one (nothing to compare it to) — absent when the template has no
   * pin yet. Mirrors `ConsultationContextSchemaVersionResponse.versionSkew`.
   */
  @ApiPropertyOptional({ enum: ['IDENTICAL', 'ADDITIVE', 'BREAKING'] })
  versionSkew?: ShapeChangeClassification;
}

/**
 * The RESOLVED, PINNED template a generation node (or the live loop) reads.
 *
 * Every field is nullable because "this tenant has configured no document
 * template" is an ordinary, expected state that must NOT be reported as 404: a
 * 404 is indistinguishable from a routing mistake, and a caller that cannot
 * tell those apart cannot decide whether to fall back to the platform shape.
 * Mirrors `ConsultationContextSchemaBundleResponse`.
 */
export class DocumentTemplateBundleResponse {
  @ApiPropertyOptional({ nullable: true }) templateId: string | null;
  @ApiPropertyOptional({ nullable: true }) slug: string | null;
  @ApiPropertyOptional({ nullable: true }) name: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The PINNED version number — never simply the latest published one.' })
  versionNumber: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Stamp this on anything generated against the template.' })
  documentTemplateVersionId: string | null;
  @ApiPropertyOptional({ nullable: true }) checksum: string | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true })
  shape: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true })
  compiled: Record<string, unknown> | null;
  @ApiProperty({
    description:
      'Strong RFC 7232 validator over the SERVED representation (template identity + pinned version + shape bytes). ' +
      'Unconfigured tenants get `"none"`.',
  })
  etag: string;
}
