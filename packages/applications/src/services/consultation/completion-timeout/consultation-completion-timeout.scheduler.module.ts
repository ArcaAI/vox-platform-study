import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobQueue } from '@arcaai/domains';
import { ConsultationCompletionTimeoutScheduler } from './consultation-completion-timeout.scheduler';

/**
 * The completion-timeout clock is retired (the auto-close sweep replaces it). The module stays one
 * release so its two former callers keep resolving the scheduler, which now only clears jobs that
 * were still pending.
 */
@Module({
  imports: [BullModule.registerQueue({ name: JobQueue.ConsultationCompletionTimeout })],
  providers: [ConsultationCompletionTimeoutScheduler],
  exports: [ConsultationCompletionTimeoutScheduler],
})
export class ConsultationCompletionTimeoutSchedulerModule {}
