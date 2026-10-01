import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue } from '@arcaai/domains';

import { createWorkerSession } from '../../../common/worker-session';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const { restoreId, tenantId } = job.data ?? ({} as CheckpointRestoreJob);
    if (typeof restoreId !== 'string' || !restoreId) {
      this.logger.error({ message: 'Restore job without a restoreId', jobId: job.id });
      throw new UnrecoverableError('restore job without a restoreId');
    }
    // The tenant comes from the job, never from the row: the row cannot be read before the session exists.
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
      this.logger.error({ message: 'Restore job without a valid tenantId', jobId: job.id, restoreId });
      throw new UnrecoverableError('restore job without a tenantId');
    }
    await runJobInContext(this.cls, job, () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'tenant-checkpoint-restore' }) as never);
      return this.runner.run(restoreId);
    });
  }
}
