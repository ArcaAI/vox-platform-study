import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { IAiRuntimeProfileService } from './IAiRuntimeProfileService';
import { AiRuntimeProfileService } from './ai-runtime-profile.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [{ provide: IAiRuntimeProfileService, useClass: AiRuntimeProfileService }, AiRuntimeProfileService],
  exports: [IAiRuntimeProfileService, AiRuntimeProfileService],
})
export class AiRuntimeProfileServiceModule {}
