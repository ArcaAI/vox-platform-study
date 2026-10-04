import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../../baseServices/redis';
import { JobIdempotencyService } from './job-idempotency.service';

/**
 * TASK-1038 B3a — `JobIdempotencyService` for job starts OUTSIDE the consultation job service
 * (the ASR transcription upload). Standalone so a consumer does not pull in the whole
 * consultation job graph to dedupe one POST.
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [JobIdempotencyService],
  exports: [JobIdempotencyService],
})
export class JobIdempotencyModule {}
