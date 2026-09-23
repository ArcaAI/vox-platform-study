import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobQueue } from '@arcaai/domains';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ConsultationCompletionTimeoutScheduler } from './consultation-completion-timeout.scheduler';

/**
 * TASK-1001 wave 6 — the ENQUEUE half of the consultation completion timeout, importable by the two
 * writers that start and stop the clock (`HarnessInternalService.persistDraft`,
 * `ConsultationService.startRecording`). The WORKER half (`ConsultationCompletionTimeoutProcessor`)
 * is registered beside `HarnessInternalService` in `HarnessInternalServiceModule`, which it needs.
 */
@Module({
  imports: [EffectiveSettingsModule, BullModule.registerQueue({ name: JobQueue.ConsultationCompletionTimeout })],
  providers: [ConsultationCompletionTimeoutScheduler],
  exports: [ConsultationCompletionTimeoutScheduler],
})
export class ConsultationCompletionTimeoutSchedulerModule {}
