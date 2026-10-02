import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The time span the accepted batch covers — echoed so a caller can see what the server understood. */
export class DnaIngestWindowResponse {
  @ApiProperty({ description: 'ISO-8601 `writtenAt` of the OLDEST accepted sample.', example: '2026-08-01T08:00:00.000Z' })
  from!: string;

  @ApiProperty({ description: 'ISO-8601 `writtenAt` of the NEWEST accepted sample.', example: '2026-09-01T09:30:00.000Z' })
  to!: string;
}

/**
 * TASK-974 §4.1 — the 202 body of `POST /api/v1/dna-writing-styles/ingest`.
 *
 * The work is a queued job, so this says what was ACCEPTED, not what was produced. `jobId` is
 * the handle for `GET ingest/jobs/:jobId`; the profile itself is read from the DNA surfaces the
 * clinician already has.
 */
export class DnaIngestJobResponse {
  @ApiProperty({
    description: 'The queued job — poll `GET dna-writing-styles/ingest/jobs/{jobId}` with it. `null` when `generate: false` queued nothing.',
    type: String,
    nullable: true,
  })
  jobId!: string | null;

  @ApiProperty({
    description: '`PENDING` when an analysis was enqueued (not run); `STORED` when `generate: false` only stored the samples as memory.',
    enum: ['PENDING', 'STORED'],
    example: 'PENDING',
  })
  status!: 'PENDING' | 'STORED';

  @ApiProperty({
    description: 'The clinician the profile will belong to — RESOLVED, so a caller who omitted it can see whom the server chose.',
    format: 'uuid',
  })
  clinicianUserId!: string;

  @ApiProperty({ description: 'How many samples were accepted into the job.', example: 42 })
  acceptedItems!: number;

  @ApiProperty({ description: 'The time span the accepted samples cover.', type: DnaIngestWindowResponse })
  window!: DnaIngestWindowResponse;

  @ApiPropertyOptional({ description: 'TASK-1034 — samples newly persisted as the clinician`s DNA memory (source INGEST).', example: 40 })
  stored?: number;

  @ApiPropertyOptional({ description: 'TASK-1034 — samples already in memory (same normalised text) and skipped.', example: 2 })
  duplicates?: number;
}
