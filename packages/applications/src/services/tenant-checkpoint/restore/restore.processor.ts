import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue } from '@arcaai/domains';

import { IActiveUserContext } from '../../../interfaces';
import { runJobInContext } from '../../baseServices/observability/job-context';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import type { CheckpointRestoreJob } from '../contracts';
import { CheckpointRestoreRunner } from './restore.runner';

/**
 * Restore queue. Deliberately NOT postponed while the tenant is locked — the restore holds that
 * lock. The runner records every outcome on the restore row and never throws for a restore
 * failure; a re-delivered job of a row past PENDING is a no-op.
 */
@Processor(JobQueue.TenantCheckpointRestore, { concurrency: QUEUE_CONCURRENCY[JobQueue.TenantCheckpointRestore] })
export class CheckpointRestoreProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckpointRestoreProcessor.name);

  constructor(
    private readonly runner: CheckpointRestoreRunner,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {
    super();
  }

  async process(job: Job<CheckpointRestoreJob>): Promise<void> {
    const { restoreId } = job.data ?? ({} as CheckpointRestoreJob);
    if (typeof restoreId !== 'string' || !restoreId) {
      this.logger.error({ message: 'Restore job without a restoreId', jobId: job.id });
      throw new UnrecoverableError('restore job without a restoreId');
    }
    await runJobInContext(this.cls, job, () => this.runner.run(restoreId));
  }
}
