import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty({ description: 'The queued job — poll `GET dna-writing-styles/ingest/jobs/{jobId}` with it.' })
  jobId!: string;

  @ApiProperty({ description: 'Always `PENDING` on acceptance; the job has been enqueued, not run.', example: 'PENDING' })
  status!: 'PENDING';

  @ApiProperty({
    description: 'The clinician the profile will belong to — RESOLVED, so a caller who omitted it can see whom the server chose.',
    format: 'uuid',
  })
  clinicianUserId!: string;

  @ApiProperty({ description: 'How many samples were accepted into the job.', example: 42 })
  acceptedItems!: number;

  @ApiProperty({ description: 'The time span the accepted samples cover.', type: DnaIngestWindowResponse })
  window!: DnaIngestWindowResponse;
}
