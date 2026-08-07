import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IAiTaskDefaultService } from './IAiTaskDefaultService';
import { AiTaskDefaultService } from './ai-task-default.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    AiTaskDefaultService,
    {
      provide: IAiTaskDefaultService,
      // useExisting, not useClass — useClass would construct a second
      // AiTaskDefaultService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: AiTaskDefaultService,
    },
  ],
  exports: [IAiTaskDefaultService, AiTaskDefaultService],
})
export class AiTaskDefaultServiceModule {}
