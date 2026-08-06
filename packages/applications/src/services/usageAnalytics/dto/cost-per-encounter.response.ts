import { ApiProperty } from '@nestjs/swagger';

/** Distribution of Σ costMicros per consultation over the period (TASK-615 WS-J). */
export class CostPerEncounterResponse {
  @ApiProperty({ description: 'Billing-period label, YYYY-MM.' })
  period!: string;

  @ApiProperty()
  periodStart!: string;

  @ApiProperty()
  periodEnd!: string;

  @ApiProperty({ description: 'Number of distinct consultations with attributable INTERNAL-basis usage.' })
  count!: number;

  @ApiProperty({ description: 'Integer micros.' })
  p50Micros!: string;

  @ApiProperty({ description: 'Integer micros.' })
  p90Micros!: string;

  @ApiProperty({ description: 'Integer micros.' })
  p99Micros!: string;

  @ApiProperty({ description: 'Integer micros, half-up rounded.' })
  meanMicros!: string;

  @ApiProperty({ description: 'Σ cost across every attributed consultation.' })
  totalMicros!: string;
}
