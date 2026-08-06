import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/**
 * Issue a credit (or debit) memo against a FINALIZED invoice — the ONLY
 * correction path for a closed period (D13). Append-only: a memo is never
 * edited or deleted; the correction of a memo is another memo.
 */
export class AddAdjustmentRequest {
  @ApiProperty({
    description: 'Bounded reason CODE, not prose (aggregatable, PHI-free). e.g. "goodwill_credit", "metering_correction", "sla_credit".',
    example: 'metering_correction',
  })
  @Matches(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
  reason!: string;

  @ApiProperty({
    description: 'Signed integer micros as a decimal string. NEGATIVE = credit (the common case), positive = debit.',
    example: '-50000000',
  })
  @Matches(/^-?\d{1,30}$/)
  amountMicros!: string;
}
