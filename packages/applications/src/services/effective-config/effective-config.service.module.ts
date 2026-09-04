import { Module } from '@nestjs/common';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { AiModelServiceModule } from '../stt/model/aiModel.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { EffectiveConfigService } from './effective-config.service';
import { IEffectiveConfigService } from './IEffectiveConfigService';

/**
 * Read-only composition module for the internal
 * effective-config route. Owns no repositories: `EffectiveSettingsModule`
 * supplies the registry override lane, `AiProviderConnectionServiceModule` the
 * profile rows, and the `AiTaskDefault` + `AiModel` pair the `modelWeights`
 * block (which slug a task selects, and where that model's weights come from).
 */
@Module({
  imports: [EffectiveSettingsModule, AiProviderConnectionServiceModule, AiTaskDefaultServiceModule, AiModelServiceModule],
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
