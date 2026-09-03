import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiModelDownloadStatus } from '@arcaai/domains';

/**
 * `GET admin/ai-models/:id/download` response body — 200 OK.
 *
 * FROZEN CONTRACT: `{ status, startedAt, finishedAt, fileSizeMb,
 * sha256, localPath, error }`. A parallel lane builds a UI against this
 * shape; do not rename or reshape it.
 *
 * `fileSizeMb`/`sha256`/`localPath` are read straight off the `AiModel` row
 * (`checksum` -> `sha256` in the wire shape); `startedAt`/`finishedAt`/`error`
 * have no dedicated columns and come from `metaData.download` bookkeeping
 * (see `model-download-meta.util.ts`) — `finishedAt` falls back to the row's
 * own `downloadedAt` on a DOWNLOADED row with no bookkeeping (e.g. a row
 * marked downloaded before this endpoint existed).
 */
export class ModelDownloadStatusResponse {
  @ApiProperty({ enum: AiModelDownloadStatus })
  status: AiModelDownloadStatus;

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
