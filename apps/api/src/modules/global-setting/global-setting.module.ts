import { GlobalSettingServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { GlobalSettingController } from './global-setting.controller';

/**
 * Wires the pre-existing `GlobalSettingService` (provided
 * by `GlobalSettingServiceModule`) to the new admin HTTP surface.
 */
@Module({
  imports: [GlobalSettingServiceModule],
  controllers: [GlobalSettingController],
})
export class GlobalSettingModule {}
