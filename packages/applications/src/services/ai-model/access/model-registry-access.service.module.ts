import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../../baseServices/common.service.module';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ModelRegistryAccessService } from './model-registry-access.service';

/**
 * `ModelRegistryAccessService` in its own module so the gateway can import it
 * without pulling the whole AI-model service graph. `EffectiveSettingsModule` is
 * load-bearing: without it the @Optional settings facade is undefined and the
 * toggle always reports `false`.
 */
@Module({
  imports: [CommonServiceModule, EffectiveSettingsModule],
  providers: [ModelRegistryAccessService],
  exports: [ModelRegistryAccessService],
})
export class ModelRegistryAccessServiceModule {}
