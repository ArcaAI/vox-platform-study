import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/** Compute (or idempotently recompute) the draft invoice for one tenant-month. */
export class ComputeDraftRequest {
  @ApiProperty({ description: 'Tenant whose period is drafted.' })
  // @IsString(), NOT @IsUUID(): the platform's reserved tenant ids are hand-authored
  // sentinels, not RFC-4122-versioned UUIDs, so class-validator's isUUID() REJECTS them —
  // isUUID('50000000-0000-0000-0000-000000000001') is false. That id is the seeded "Global"
  // CUSTOMER tenant, so @IsUUID() made compute-draft return 400 "tenantId must be a UUID"
  // for a real tenant. Mirrors resync-department-agents.request.ts, which documents the same
  // reasoning for the same class of id.
  @IsString()
  tenantId!: string;

  @ApiProperty({ description: 'UTC calendar month, YYYY-MM.', example: '2026-08' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period!: string;
}
