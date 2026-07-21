import { ApiProperty } from '@nestjs/swagger';

/**
 * One date bucket of the consultation range aggregation.
 * `key`/`label` mirror the FE `tenant-dashboard/chart.ts` format
 * (`yyyy-MM-dd` / `MMM d` for days, `yyyy-MM` / `MMM` for months).
 */
export class ConsultationAggregateBucket {
  @ApiProperty({ description: 'Stable bucket key (`yyyy-MM-dd` or `yyyy-MM`).' })
  key!: string;

  @ApiProperty({ description: 'Axis label (`MMM d` for days, `MMM` for months).' })
  label!: string;

  @ApiProperty({ description: 'Bucket start (ISO-8601, inclusive).' })
  start!: string;

  @ApiProperty({ description: 'Bucket end (ISO-8601, inclusive).' })
  end!: string;

  @ApiProperty({ description: 'Initial-visit consultations (parentConsultationId IS NULL).' })
  newVisits!: number;

  @ApiProperty({ description: 'Follow-up/revisit consultations (parentConsultationId IS NOT NULL).' })
  revisits!: number;

  @ApiProperty({ description: 'newVisits + revisits.' })
  total!: number;
}

export class ConsultationAggregateTotals {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  newVisits!: number;

  @ApiProperty()
  revisits!: number;
}

/**
 * Server-side date-bucketed new/revisit counts that do not
 * under-count long ranges (zero-filled across the whole window).
 */
export class ConsultationAggregateResponse {
  @ApiProperty({ type: [ConsultationAggregateBucket] })
  buckets!: ConsultationAggregateBucket[];

  @ApiProperty({ type: ConsultationAggregateTotals })
  totals!: ConsultationAggregateTotals;

  @ApiProperty({ enum: ['day', 'month'] })
  granularity!: 'day' | 'month';

  @ApiProperty({ description: 'When this payload was computed (ISO-8601).' })
  refreshedAt!: string;
}
