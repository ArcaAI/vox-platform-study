import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationContextSchemaScope, ConsultationContextSchemaStatus } from '@arcaai/domains';
import type { DefinitionChangeClassification } from '../definition-diff';

export class ConsultationContextSchemaResponse {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty({ enum: ConsultationContextSchemaScope }) scope: ConsultationContextSchemaScope;
  @ApiPropertyOptional({ nullable: true }) departmentId: string | null;
  @ApiProperty({ enum: ConsultationContextSchemaStatus }) status: ConsultationContextSchemaStatus;
  @ApiPropertyOptional({ nullable: true, description: 'The version discovery serves. Null until the first publish.' })
  pinnedVersionNumber: number | null;
  @ApiProperty() isDefault: boolean;
  @ApiPropertyOptional({ nullable: true }) sourceTemplateSlug: string | null;
  @ApiProperty() templateLocked: boolean;
  @ApiProperty({ description: 'Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor.' })
  version: number;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class ConsultationContextSchemaVersionResponse {
  @ApiProperty() id: string;
  @ApiProperty() schemaId: string;
  @ApiProperty() versionNumber: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) definition: Record<string, unknown>;
  @ApiProperty({ description: 'sha256 over the canonical JSON of `definition`.' }) checksum: string;
  @ApiPropertyOptional({ nullable: true }) changeReason: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy: string | null;
  @ApiProperty() createdAt: string;
  /**
   * Computes this classification (`classifyDefinitionChange`) but
   * previously only logged it (`ContextService`); surfaces it here so
   * an admin can see whether a client still pinned to this version would keep
   * working against the tenant's CURRENT pin. Set on every version except the
   * currently pinned one (nothing to compare it to) — absent when the schema
   * has no pin yet.
   */
  @ApiPropertyOptional({ enum: ['IDENTICAL', 'ADDITIVE', 'BREAKING'] })
  versionSkew?: DefinitionChangeClassification;
}

/**
 * The DISCOVERY bundle (/R2) — the resolved, pinned declaration a
 * client builds its workflow from.
 *
 * Every field is nullable because "this tenant has not configured a context
 * schema" is an ordinary, expected state that must NOT be reported as 404: a
 * 404 is indistinguishable from a routing mistake, and a client that cannot
 * tell those apart cannot decide whether to fall back to its built-in flow.
 */
export class ConsultationContextSchemaBundleResponse {
  @ApiPropertyOptional({ nullable: true }) schemaId: string | null;
  @ApiPropertyOptional({ nullable: true }) slug: string | null;
  @ApiPropertyOptional({ nullable: true }) name: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The PINNED version number — never simply the latest published one.' })
  versionNumber: number | null;
  @ApiPropertyOptional({ nullable: true }) contextSchemaVersionId: string | null;
  @ApiPropertyOptional({ nullable: true }) checksum: string | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true })
  definition: Record<string, unknown> | null;
  @ApiProperty({
    description:
      'Strong RFC 7232 validator over the SERVED representation (schema identity + pinned version + definition bytes). ' +
      'Unconfigured tenants get `"none"`. It moves only when what is served moves — editing the schema head row\'s ' +
      'name does not change it.',
  })
  etag: string;
}
