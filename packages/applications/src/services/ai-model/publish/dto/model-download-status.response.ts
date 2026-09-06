import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MODEL_PUBLISH_STATUSES, type ModelPublishStatus } from '../model-download-meta.util';

/**
 * `GET admin/ai-models/:id/download` response body — 200 OK.
 *
 * FROZEN CONTRACT: `{ status, startedAt, finishedAt, fileSizeMb,
 * sha256, localPath, error }`. A parallel lane builds a UI against this
 * shape; do not rename or reshape it.
 *
 * TASK-890 §3.11 — the SHAPE is unchanged, every SOURCE moved. The four
 * bookkeeping columns are dropped, so `status` is DERIVED from the measured
 * `availability` plus the run bookkeeping (`derivePublishStatus`), `fileSizeMb`
 * comes from that same bookkeeping, `localPath` is derived from the row's bucket
 * identity, and only `sha256` (`AiModel.checksum`) is still a column read.
 */
export class ModelDownloadStatusResponse {
  @ApiProperty({ enum: MODEL_PUBLISH_STATUSES })
  status: ModelPublishStatus;

  @ApiPropertyOptional({ description: 'When the most recent download job started.', nullable: true })
  startedAt: Date | null;

  @ApiPropertyOptional({ description: 'When the most recent download job finished (success or failure).', nullable: true })
  finishedAt: Date | null;

  @ApiPropertyOptional({ description: 'Total downloaded size in MB.', nullable: true })
  fileSizeMb: number | null;

  @ApiPropertyOptional({ description: 'SHA256 of the primary weights object.', nullable: true })
  sha256: string | null;

  @ApiPropertyOptional({
    description: 'Mount-path the s3fs sidecar serves this version at, e.g. /mnt/models-bucket/<slug>/<version>/.',
    nullable: true,
  })
  localPath: string | null;

  @ApiPropertyOptional({ description: 'Failure message from the most recent DOWNLOAD_FAILED job, if any.', nullable: true })
  error: string | null;
}
