import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { FeedbackRollupService } from './feedback-rollup.service';
import { FeedbackRollupReadService } from './feedback-rollup.reader';
import { IFeedbackRollupReaderToken } from './IFeedbackRollupReader';

/**
 * Registers the self-scheduling {@link FeedbackRollupService}. Relies on the
 * app-level globals `ScheduleModule.forRoot()`, `EventEmitterModule.forRoot()`
 * and (optionally) the `@Global` Redis cache module for the run lock.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [FeedbackRollupService, FeedbackRollupReadService, { provide: IFeedbackRollupReaderToken, useExisting: FeedbackRollupReadService }],
  exports: [FeedbackRollupService, IFeedbackRollupReaderToken],
})
export class FeedbackRollupServiceModule {}
