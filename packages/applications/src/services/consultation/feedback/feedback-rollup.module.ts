import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { FeedbackRollupService } from './feedback-rollup.service';

/**
 * Registers the self-scheduling {@link FeedbackRollupService}. Relies on the
 * app-level globals `ScheduleModule.forRoot()`, `EventEmitterModule.forRoot()`
 * and (optionally) the `@Global` Redis cache module for the run lock.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [FeedbackRollupService],
  exports: [FeedbackRollupService],
})
export class FeedbackRollupServiceModule {}
