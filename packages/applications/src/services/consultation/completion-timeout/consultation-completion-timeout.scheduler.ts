/**
 * The consultation completion-timeout clock, RETIRED. A consultation that is left alone is closed
 * by the auto-close sweep under `consultation.autoClose`; nothing is scheduled here any more.
 *
 * What remains: {@link ConsultationCompletionTimeoutScheduler.cancel} still removes a job that was
 * pending at deploy time, and `schedule` is a no-op kept so the existing callers compile until they
 * drop it. Delete this folder with the queue once no job is pending.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobQueue } from '@arcaai/domains';

export interface ConsultationCompletionTimeoutJob {
  tenantId: string;
  consultationId: string;
}

/** The ONE pending job a consultation could have. BullMQ custom ids may not contain `:`. */
export function completionTimeoutJobId(consultationId: string): string {
  return `completion-${consultationId}`;
}

@Injectable()
export class ConsultationCompletionTimeoutScheduler {
  private readonly logger = new Logger(ConsultationCompletionTimeoutScheduler.name);

  constructor(@InjectQueue(JobQueue.ConsultationCompletionTimeout) private readonly queue: Queue) {}

  /** No longer schedules anything; always `null`. */
  async schedule(_tenantId: string, _consultationId: string): Promise<{ timeoutMinutes: number; deadlineAt: string } | null> {
    return null;
  }

  /** Drops a window that was still pending from before the clock was retired. Never throws. */
  async cancel(consultationId: string): Promise<void> {
    try {
      const pending = await this.queue.getJob(completionTimeoutJobId(consultationId));
      await pending?.remove().catch(() => undefined);
    } catch (error) {
      this.logger.warn({
        message: 'Could not clear a pending completion timeout - the retired processor drains it without action',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
