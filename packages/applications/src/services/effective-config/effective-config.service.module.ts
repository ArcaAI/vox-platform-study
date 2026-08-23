import { Module } from '@nestjs/common';
import { AiRuntimeProfileServiceModule } from '../ai-runtime-profile/ai-runtime-profile.service.module';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { AiModelServiceModule } from '../stt/model/aiModel.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { EffectiveConfigService } from './effective-config.service';
import { IEffectiveConfigService } from './IEffectiveConfigService';

/**
 * Read-only composition module for the internal
 * effective-config route. Owns no repositories: `EffectiveSettingsModule`
 * supplies the registry override lane, `AiRuntimeProfileServiceModule` the
 * profile rows, and the `AiTaskDefault` + `AiModel` pair the `modelWeights`
 * block (which slug a task selects, and where that model's weights come from).
 */
@Module({
  imports: [EffectiveSettingsModule, AiRuntimeProfileServiceModule, AiTaskDefaultServiceModule, AiModelServiceModule],
  providers: [
    EffectiveConfigService,
    {
      provide: IEffectiveConfigService,
      // useExisting, not useClass — useClass would construct a second
      // EffectiveConfigService instance instead of aliasing the one above.
      // It's a read-only composition service with no state of its own, so
      // the duplicate was harmless, but aliasing is free.
      useExisting: EffectiveConfigService,
    },
  ],
  exports: [IEffectiveConfigService, EffectiveConfigService],
})
export class EffectiveConfigServiceModule {}
