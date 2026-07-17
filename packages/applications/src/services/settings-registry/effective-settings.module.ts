import { Module } from '@nestjs/common';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { ConfigResolverModule } from '../config-resolver/config-resolver.module';
import { EffectiveSettingsService } from './effective-settings.service';

/**
 * TASK-504 — DI module for the EffectiveSettingsService facade. Imports
 * ConfigResolverModule for the pipeline cascade resolver and (TASK-506)
 * AiTaskDefaultServiceModule for the models.* task-default resolver.
 */
@Module({
  imports: [ConfigResolverModule, AiTaskDefaultServiceModule],
  providers: [EffectiveSettingsService],
  exports: [EffectiveSettingsService],
})
export class EffectiveSettingsModule {}
