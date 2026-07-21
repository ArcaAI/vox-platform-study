import { Module } from '@nestjs/common';
import { AiRuntimeProfileServiceModule } from '../ai-runtime-profile/ai-runtime-profile.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { EffectiveConfigService } from './effective-config.service';
import { IEffectiveConfigService } from './IEffectiveConfigService';

/**
 * Read-only composition module for the internal
 * effective-config route. Owns no repositories: `EffectiveSettingsModule`
 * supplies the registry override lane and `AiRuntimeProfileServiceModule` the
 * profile rows.
 */
@Module({
  imports: [EffectiveSettingsModule, AiRuntimeProfileServiceModule],
  providers: [{ provide: IEffectiveConfigService, useClass: EffectiveConfigService }, EffectiveConfigService],
  exports: [IEffectiveConfigService, EffectiveConfigService],
})
export class EffectiveConfigServiceModule {}
