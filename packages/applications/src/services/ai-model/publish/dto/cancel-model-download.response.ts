import { ApiProperty } from '@nestjs/swagger';
import type { CancelModelDownloadResponse as CancelModelDownloadResponseContract } from '@arcaai/types';

/** `POST admin/ai-models/:id/download/cancel` → 202 (TASK-1023 D-C). */
export class CancelModelDownloadResponse implements CancelModelDownloadResponseContract {
  @ApiProperty({ description: 'The download job being cancelled.' })
  jobId: string;

  @ApiProperty({
    enum: ['removed', 'cancelling'],
    description: '`removed` = the job was still queued and is gone (the row reads DOWNLOAD_CANCELLED now); `cancelling` = the worker is stopping it.',
  })
  outcome: 'removed' | 'cancelling';

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The unregister job that follows when `removeRegistration` was requested on a queued job; null otherwise (a running job is unregistered by the worker after cleanup).',
  })
  unregisterJobId: string | null;
}
