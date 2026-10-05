import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JobQueue } from '@arcaai/domains';
import { QUEUE_CONCURRENCY } from '../../baseServices/redis/queue-concurrency';
import type { ConsultationCompletionTimeoutJob } from './consultation-completion-timeout.scheduler';

/**
 * Drains the completion-timeout jobs that were already pending when the clock was retired. The
 * auto-close sweep (`consultation.autoClose`) owns closing now, so a job that fires does nothing;
 * the processor exists only so queued jobs finish instead of failing and retrying. Delete it, the
 * scheduler and the queue once the queue is empty.
 */
@Processor(JobQueue.ConsultationCompletionTimeout, { concurrency: QUEUE_CONCURRENCY[JobQueue.ConsultationCompletionTimeout] })
export class ConsultationCompletionTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(ConsultationCompletionTimeoutProcessor.name);

  async process(job: Job<ConsultationCompletionTimeoutJob>): Promise<void> {
    this.logger.log({ message: 'Retired completion-timeout job drained without action', jobId: job.id, consultationId: job.data?.consultationId });
  }
}
