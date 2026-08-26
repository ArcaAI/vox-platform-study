import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { DocumentTemplateStatus } from '@arcaai/domains';
import { DOCUMENT_SECTION_KEY_PATTERN } from '../document-template-shape';

/**
 * Request DTOs for the clinical-document SHAPE catalog.
 *
 * `tenantId` is NEVER a field on any of these: it is read from CLS by the
 * service, and the global pipe runs `forbidNonWhitelisted`, so a caller cannot
 * forge one.
 *
 * Neither is any SERVER-STAMPED column — `checksum`, `versionNumber`,
 * `compiled`, `compilerVersion` and `pinnedVersionNumber` are all absent by
 * design, which is what makes them unsubmittable rather than merely ignored.
 * A caller that could post its own `checksum` could defeat idempotent
 * republish; one that could post `compiled` could publish a template whose
 * decoding constraint does not match its declared shape, which is the single
 * thing this catalog exists to guarantee cannot happen.
 */
export class CreateDocumentTemplateRequest {
  @ApiProperty({ description: 'Stable tenant-invented identifier, unique per tenant.', example: 'discharge_summary' })
  @IsString()
  @Matches(DOCUMENT_SECTION_KEY_PATTERN, { message: 'slug must match [a-z0-9_]{2,48}' })
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

  @ApiPropertyOptional({ description: 'Make this the template a generation node resolves when its config names none.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Golden-library provenance: the SYSTEM template slug this was cloned from.' })
  @IsOptional()
  @IsString()
  sourceTemplateSlug?: string;

  @ApiPropertyOptional({ description: 'Whether a golden-library resync may overwrite this template.' })
  @IsOptional()
  @IsBoolean()
  templateLocked?: boolean;
}

export class UpdateDocumentTemplateRequest {
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

  @ApiPropertyOptional({ description: 'Make (or unmake) this the tenant default.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Governance status. Moving to APPROVED records a clinical sign-off; moving back to DRAFT makes the template ' +
      'unservable without discarding its published versions.',
    enum: DocumentTemplateStatus,
  })
  @IsOptional()
  @IsEnum(DocumentTemplateStatus)
  status?: DocumentTemplateStatus;

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

export class PublishDocumentTemplateRequest {
  @ApiProperty({
    description:
      'The document SHAPE: `{ schemaVersion: "1.0", title, globalInstruction?, sections[] }`. Each section declares ' +
      '`key`, `title`, `form` (PROSE | BULLETS | STRUCTURED), an optional per-section `instruction`, and `required` ' +
      '(default FALSE — an optional section compiles to a NULLABLE property so the model can record that it was not ' +
      'discussed instead of inventing content). A STRUCTURED section must carry `fields`, a constrained JSON Schema ' +
      'draft 2020-12 subset. Rejected as 400 with every problem listed.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  shape: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Why this version was published — recorded immutably on the version row.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeReason?: string;

  @ApiPropertyOptional({
    description:
      'Acknowledges that this publish BREAKS readers built against the previous version (a removed or renamed ' +
      'section, a changed `form`, a changed STRUCTURED `fields` contract, or a section newly made `required`). ' +
      'Without it a breaking publish is refused with 400 listing each break.',
  })
  @IsOptional()
  @IsBoolean()
  allowBreakingChange?: boolean;
}

export class PinDocumentTemplateVersionRequest {
  @ApiProperty({ description: 'The immutable version number to serve. Must already exist.' })
  @IsInt()
  @Min(1)
  versionNumber: number;
}
