import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AsrAgentResolverServiceModule } from '../../stt/agent-resolver/asr-agent-resolver.service.module';
import { VoiceProfileService } from './voiceProfile.service';
import { IVoiceProfileService } from './IVoiceProfileService';

@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    // TASK-887 — enrollment resolves the SAME agent a session would, so the profile lands in
    // the embedding space that will actually match it.
    AsrAgentResolverServiceModule,
    HttpModule.register({
      timeout: 60000,
      maxRedirects: 0,
    }),
  ],
  providers: [
    {
      provide: IVoiceProfileService,
      useClass: VoiceProfileService,
    },
  ],
  exports: [IVoiceProfileService],
})
export class VoiceProfileServiceModule {}
