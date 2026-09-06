import { ApiProperty } from '@nestjs/swagger';
import { MODEL_PUBLISH_STATUSES, type ModelPublishStatus } from '../model-download-meta.util';

/**
 * `POST admin/ai-models/:id/download` response body — 202 Accepted.
 *
 * FROZEN CONTRACT: `{ jobId, status: 'DOWNLOADING' }`. A parallel
 * lane builds a UI against this shape; do not rename or reshape it.
 */
export class TriggerModelDownloadResponse {
  @ApiProperty({ description: 'BullMQ job id for the enqueued download — poll with GET :id/download.' })
  jobId: string;

  @ApiProperty({ description: 'Always DOWNLOADING on a successful trigger.', enum: MODEL_PUBLISH_STATUSES })
  status: ModelPublishStatus;
}
