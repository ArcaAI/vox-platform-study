import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { IAiRuntimeProfileService } from './IAiRuntimeProfileService';
import { AiRuntimeProfileService } from './ai-runtime-profile.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    AiRuntimeProfileService,
    {
      provide: IAiRuntimeProfileService,
      // useExisting, not useClass — useClass would construct a second
      // AiRuntimeProfileService instance instead of aliasing the one above.
      // No cache/listener/timer state here, so the duplicate was harmless,
      // but aliasing is free.
      useExisting: AiRuntimeProfileService,
    },
  ],
  exports: [IAiRuntimeProfileService, AiRuntimeProfileService],
})
export class AiRuntimeProfileServiceModule {}
