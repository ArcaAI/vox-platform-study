import { VoiceProfileServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { VoiceProfileRedirectShimController } from './voice-profile-redirect.shim.controller';
import { VoiceProfileController } from './voice-profile.controller';

@Module({
  imports: [VoiceProfileServiceModule],
  controllers: [VoiceProfileController, VoiceProfileRedirectShimController],
})
export class VoiceProfileModule {}
