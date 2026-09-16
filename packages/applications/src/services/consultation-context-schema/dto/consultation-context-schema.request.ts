import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ConsultationContextSchemaScope, ConsultationContextSchemaStatus } from '@arcaai/domains';
import { CONTEXT_KIND_KEY_PATTERN } from '../context-schema-definition';

/**
 * Request DTOs.
 *
 * `tenantId` is NEVER a field on any of these: it is read from CLS by the
 * service, and the global pipe runs `forbidNonWhitelisted`, so a caller cannot
 * forge one. The tenant-defined part of the payload rides exactly ONE declared
 * envelope field (`definition`) and is validated in the service layer, which
 * is what constraint C7 requires.
 */
export class CreateConsultationContextSchemaRequest {
  @ApiProperty({ description: 'Stable tenant-invented identifier, unique per tenant.', example: 'general_medicine_context' })
  @IsString()
  @Matches(CONTEXT_KIND_KEY_PATTERN, { message: 'slug must match [a-z0-9_]{2,48}' })
  slug: string;

  @ApiProperty({ description: 'Human-readable name.' })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ description: 'Free-text description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Which consultations this schema governs.', enum: ConsultationContextSchemaScope })
  @IsOptional()
  @IsEnum(ConsultationContextSchemaScope)
  scope?: ConsultationContextSchemaScope;

  @ApiPropertyOptional({ description: 'Required for DEPARTMENT scope, forbidden for TENANT scope.' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Make this the schema discovery resolves to for its scope.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Golden-library provenance: the SYSTEM schema slug this was cloned from.' })
  @IsOptional()
  @IsString()
  sourceTemplateSlug?: string;

  @ApiPropertyOptional({ description: 'Whether a golden-library resync may overwrite this schema.' })
  @IsOptional()
  @IsBoolean()
  templateLocked?: boolean;
}

export class UpdateConsultationContextSchemaRequest {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Make (or unmake) this the default for its scope.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Governance status. Moving to APPROVED records a sign-off; moving back to DRAFT makes the schema unservable ' +
      'without discarding its published versions.',
    enum: ConsultationContextSchemaStatus,
  })
  @IsOptional()
  @IsEnum(ConsultationContextSchemaStatus)
  status?: ConsultationContextSchemaStatus;

  @ApiPropertyOptional({ description: 'Optimistic-concurrency version; the `If-Match` header overrides it when both are present.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  templateLocked?: boolean;
}

export class PublishConsultationContextSchemaRequest {
  @ApiProperty({
    description:
      'The declaration. Each `kinds[].primitive` must be one of STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED; ' +
      '`fields` is a constrained JSON Schema draft 2020-12 subset (no if/then/else; `oneOf` only with an explicit ' +
      'discriminator). Rejected as 400 with every problem listed.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  definition: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Why this version was published — recorded immutably on the version row.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeReason?: string;

  @ApiPropertyOptional({
    description:
      'Acknowledges that this publish BREAKS clients built against the previous version (a removed or renamed kind ' +
      'or property, a changed primitive/type, a widened `required`). Without it a breaking publish is refused with ' +
      '400 listing each break.',
  })
  @IsOptional()
  @IsBoolean()
  allowBreakingChange?: boolean;

  @ApiPropertyOptional({
    description:
      'Acknowledges that this publish breaks a WORKFLOW or AGENT already bound to this schema — a consumer ' +
      'PINNED to an older version whose frozen trigger would reject a kind this definition adds. Distinct from ' +
      '`allowBreakingChange`, which is about CLIENTS built against the previous version: a publish can be ' +
      'perfectly additive for clients and still break a pinned workflow. Without it such a publish is refused ' +
      'with 400 `SCHEMA_IMPACT_UNACKNOWLEDGED`, carrying the full impact document.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeImpact?: boolean;
}

export class PinConsultationContextSchemaVersionRequest {
  @ApiProperty({ description: 'The immutable version number to serve. Must already exist.' })
  @IsInt()
  @Min(1)
  versionNumber: number;
}
