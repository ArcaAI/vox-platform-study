import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

/** Compute (or idempotently recompute) the draft invoice for one tenant-month. */
export class ComputeDraftRequest {
  @ApiProperty({ description: 'Tenant whose period is drafted.' })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ description: 'UTC calendar month, YYYY-MM.', example: '2026-08' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;
}
