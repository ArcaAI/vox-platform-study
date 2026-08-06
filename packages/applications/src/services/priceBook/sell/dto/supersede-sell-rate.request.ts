import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Supersede one SELL rate row: close its window at `effectiveFrom` and insert
 * the successor starting there — atomically, in one transaction (D10).
 *
 * DIMENSIONS ARE INHERITED. A supersede REPRICES a row; it never re-shapes it.
 * Changing what a row is keyed on is a new row (`POST /rate-card`) plus a
 * supersede of the old one — two auditable intents, not one ambiguous edit.
 */
export class SupersedeSellRateRequest {
  @ApiProperty({ description: 'Successor price in integer micros (non-negative decimal-integer string).', example: '8' })
  @Matches(/^\d{1,30}$/)
  unitPriceMicros!: string;

  @ApiProperty({ description: 'Instant the successor takes effect = the instant the old row closes (ISO 8601). Half-open windows abut exactly.' })
  @IsISO8601()
  effectiveFrom!: string;

  @ApiProperty({ description: 'Book label of the successor row.', example: '2026-09-01-commercial-v3' })
  @IsString()
  @MaxLength(120)
  bookVersion!: string;
}
