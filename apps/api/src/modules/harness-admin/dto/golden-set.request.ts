import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /admin/harness/golden-sets`. The owning
 * tenant is resolved server-side (CLS tenant, or `?tenantId=` for platform
 * admins) — never taken from the body.
 */
export class CreateGoldenSetRequest {
  @ApiProperty({ description: 'Human-readable set name.', example: 'GI consultations golden set', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'Free-text description.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Pinned dataset version tag.', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pinnedVersion?: string;

  @ApiPropertyOptional({
    description: 'Scope the set to a single department (omit for tenant-wide). Must belong to the caller tenant — a mismatch 404s.',
  })
  @IsOptional()
  @IsString()
  departmentId?: string;
}

/**
 * Body for `POST /admin/harness/golden-sets/:id/cases`.
 * `transcript`/`referenceNote` are PHI: encrypted at rest on write and NEVER
 * echoed back through the admin read plane (responses carry metadata only).
 */
export class CreateGoldenCaseRequest {
  @ApiProperty({ description: 'Source consultation transcript (PHI — write-only through this surface).' })
  @IsString()
  @MinLength(1)
  transcript: string;

  @ApiProperty({ description: 'Reference (gold) clinical note (PHI — write-only through this surface).' })
  @IsString()
  @MinLength(1)
  referenceNote: string;

  @ApiPropertyOptional({ description: 'Case label for humans (e.g. `case-gi-007`).', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}
