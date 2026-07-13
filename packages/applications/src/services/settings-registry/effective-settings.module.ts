import { Module } from '@nestjs/common';
import { ConfigResolverModule } from '../config-resolver/config-resolver.module';
import { EffectiveSettingsService } from './effective-settings.service';

/**
 * TASK-504 — DI module for the EffectiveSettingsService facade. Imports
 * ConfigResolverModule for the pipeline cascade resolver.
 */
@Module({
  imports: [ConfigResolverModule],
  providers: [EffectiveSettingsService],
  exports: [EffectiveSettingsService],
})
export class EffectiveSettingsModule {}
