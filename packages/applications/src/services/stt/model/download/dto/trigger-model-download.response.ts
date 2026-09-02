import { ApiProperty } from '@nestjs/swagger';
import { AiModelDownloadStatus } from '@arcaai/domains';

/**
 * `POST admin/ai-models/:id/download` response body — 202 Accepted.
 *
 * FROZEN CONTRACT (TASK-855): `{ jobId, status: 'DOWNLOADING' }`. A parallel
 * lane builds a UI against this shape; do not rename or reshape it.
 */
export class TriggerModelDownloadResponse {
  @ApiProperty({ description: 'BullMQ job id for the enqueued download — poll with GET :id/download.' })
  jobId: string;

  @ApiProperty({ description: 'Always DOWNLOADING on a successful trigger.', enum: AiModelDownloadStatus })
  status: AiModelDownloadStatus;
}
