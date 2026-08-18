import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of erasing a clinician's learned writing-style profile (INV-240 /
 * INV-241).
 *
 * Counts only — the erased profile text is PHI-derived and is never echoed
 * back on the way out.
 */
export class DnaErasureResponse {
  @ApiProperty({ description: 'The clinician whose writing-style profile was erased.' })
  doctorId!: string;

  @ApiProperty({ description: 'Number of DNA writing-style reports soft-deleted.' })
  deletedReports!: number;

  @ApiProperty({ description: 'Number of historical report versions soft-deleted alongside them.' })
  deletedVersions!: number;
}
