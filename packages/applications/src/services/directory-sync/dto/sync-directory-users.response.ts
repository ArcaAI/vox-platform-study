import { ApiProperty } from '@nestjs/swagger';

/** The enqueued job id. Poll progress/result via `GET /admin/queues/SyncTenantDirectoryUsers/jobs/:jobId`. */
export class SyncDirectoryUsersResponse {
  @ApiProperty({ description: 'BullMQ job id for this directory sync run' })
  jobId!: string;
}
