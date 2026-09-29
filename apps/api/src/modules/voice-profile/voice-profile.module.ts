import { VoiceProfileServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { VoiceProfileController } from './voice-profile.controller';

@Module({
  imports: [VoiceProfileServiceModule],
  controllers: [VoiceProfileController],
})
export class VoiceProfileModule {}
