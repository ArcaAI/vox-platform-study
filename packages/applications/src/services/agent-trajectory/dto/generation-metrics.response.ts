import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One stop-reason bucket in a generation-metrics aggregate. */
export class GenerationStopReasonCount {
  @ApiProperty({ description: 'Normalized AD-1 stop_reason (e.g. stop, length, tool_call).' })
  reason: string;

  @ApiProperty({ description: 'Number of LLM_CALL samples with this stop reason.' })
  count: number;
}

/**
 * TASK-509 follow-up — server-side rollup of trajectory LLM_CALL GenerationStats
 * for the admin Metrics screen. Shape mirrors the console `GenerationAggregate`.
 */
export class GenerationMetricsAggregateResponse {
  @ApiProperty({ description: 'LLM_CALL steps that carried parseable GenerationStats.' })
  sampleCount: number;

  @ApiPropertyOptional({ nullable: true, description: 'Median TTFT across samples (ms).' })
  ttftMedianMs: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'p95 TTFT across samples (ms).' })
  ttftP95Ms: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Mean tokens/sec across samples.' })
  tokensPerSecondAvg: number | null;

  @ApiProperty({ type: [GenerationStopReasonCount] })
  stopReasons: GenerationStopReasonCount[];
}
