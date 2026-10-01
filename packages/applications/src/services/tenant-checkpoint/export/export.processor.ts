import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { JobQueue } from '@arcaai/domains';

import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { runJobInContext } from '../../baseServices/observability/job-context';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import { ICheckpointExportRunner, ICheckpointVerifyRunner, type CheckpointExportJob } from '../contracts';

/**
 * Checkpoint export queue: `create` runs the export, `verify-upload` the verification gate over an
 * uploaded file. Deliberately NOT postponed while the tenant is locked — a restore's SAFETY
 * checkpoint runs through this queue while the lock is held. The runners keep their outcome on
 * the row and never throw for a job failure, so a retry only happens for an infrastructure error
 * before the row was touched (a re-delivery of a finished job is a no-op).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Processor(JobQueue.TenantCheckpointExport, { concurrency: QUEUE_CONCURRENCY[JobQueue.TenantCheckpointExport] })
export class CheckpointExportProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckpointExportProcessor.name);

  constructor(
    @Inject(ICheckpointExportRunner) private readonly exportRunner: ICheckpointExportRunner,
    @Inject(ICheckpointVerifyRunner) private readonly verifyRunner: ICheckpointVerifyRunner,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {
    super();
  }

  async process(job: Job<CheckpointExportJob>): Promise<void> {
    const { kind, checkpointId, tenantId } = job.data ?? ({} as CheckpointExportJob);
    if (typeof checkpointId !== 'string' || !checkpointId) throw new UnrecoverableError('checkpoint job without a checkpointId');
    // The tenant comes from the job, never from the row: the row cannot be read before the session exists.
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
      this.logger.error({ message: 'Checkpoint job without a valid tenantId', jobId: job.id });
      throw new UnrecoverableError('checkpoint job without a tenantId');
    }
    await runJobInContext(this.cls, job, async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set(
        'user',
        createWorkerSession({ tenantId, kind: kind === 'verify-upload' ? 'tenant-checkpoint-verify' : 'tenant-checkpoint-export' }) as never,
      );
      switch (kind) {
        case 'create':
          return this.exportRunner.run(checkpointId);
        case 'verify-upload':
          return this.verifyRunner.run(checkpointId);
        default:
          this.logger.error({ message: 'Unknown checkpoint job kind', jobId: job.id });
          throw new UnrecoverableError('unknown checkpoint job kind');
      }
    });
  }
}
