import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { VoiceProfileService } from './voiceProfile.service';
import { IVoiceProfileService } from './IVoiceProfileService';

@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
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
