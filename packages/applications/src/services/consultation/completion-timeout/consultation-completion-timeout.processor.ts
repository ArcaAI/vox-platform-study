import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JobQueue } from '@arcaai/domains';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import { HarnessInternalService } from '../harness/harness-internal.service';
import type { ConsultationCompletionTimeoutJob } from './consultation-completion-timeout.scheduler';

/**
 * TASK-1001 wave 6 — the consultation completion timeout FIRED. Hands the decision to the lifecycle
 * writer, which closes the consultation unsigned only if it is still waiting for approval (a signed,
 * recording or already-closed consultation is left alone). See the scheduler for the why.
 */
@Processor(JobQueue.ConsultationCompletionTimeout, { concurrency: QUEUE_CONCURRENCY[JobQueue.ConsultationCompletionTimeout] })
export class ConsultationCompletionTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(ConsultationCompletionTimeoutProcessor.name);

  constructor(private readonly harnessInternal: HarnessInternalService) {
    super();
  }

  async process(job: Job<ConsultationCompletionTimeoutJob>): Promise<void> {
    const { tenantId, consultationId } = job.data;
    if (!tenantId || !consultationId) {
      this.logger.error({ message: 'Completion-timeout job without tenantId/consultationId — dropped', jobId: job.id });
      return;
    }
    await this.harnessInternal.closeOnCompletionTimeout(consultationId, tenantId);
  }
}
