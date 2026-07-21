import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One golden set — read projection of `GoldenSet`. */
export class GoldenSetResponse {
  @ApiProperty({ description: 'Golden set id.' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiProperty({ description: 'Human-readable set name.' })
  name: string;

  @ApiPropertyOptional({ description: 'Free-text description (null when unset).', nullable: true })
  description: string | null;

  @ApiPropertyOptional({ description: 'Pinned dataset version tag (null when unpinned).', nullable: true })
  pinnedVersion: string | null;

  @ApiProperty({ description: 'Created timestamp (ISO-8601).' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp (ISO-8601).' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Creating user id (null for system writes).', nullable: true })
  createdBy: string | null;
}

/** Paginated golden-set listing. */
export class GoldenSetListResponse {
  @ApiProperty({ type: [GoldenSetResponse] })
  items: GoldenSetResponse[];

  @ApiProperty({ description: 'Total sets matching the filter (across all pages).', example: 4 })
  total: number;
}

/**
 * One golden case, PHI-SAFE projection: the clinical payload
 * columns (`transcript`, `referenceNote`) are Vault-encrypted PHI and are
 * deliberately NEVER surfaced through the admin read plane — only metadata.
 */
export class GoldenCaseMetaResponse {
  @ApiProperty({ description: 'Golden case id.' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiProperty({ description: 'Parent golden set id.' })
  goldenSetId: string;

  @ApiPropertyOptional({ description: 'Case label (null when unset).', nullable: true })
  label: string | null;

  @ApiProperty({ description: 'Created timestamp (ISO-8601).' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp (ISO-8601).' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Creating user id (null for system writes).', nullable: true })
  createdBy: string | null;
}

/** Paginated golden-case listing (PHI-safe metadata only). */
export class GoldenCaseListResponse {
  @ApiProperty({ type: [GoldenCaseMetaResponse] })
  items: GoldenCaseMetaResponse[];

  @ApiProperty({ description: 'Total cases in the set (across all pages).', example: 25 })
  total: number;
}
