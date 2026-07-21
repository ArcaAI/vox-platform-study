import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { ConfigResolverModule } from '../config-resolver/config-resolver.module';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { EffectiveSettingsService } from './effective-settings.service';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import { SettingsRegistryWriteService } from './settings-registry-write.service';

/**
 * DI module for the EffectiveSettingsService facade. Imports
 * ConfigResolverModule for the pipeline cascade resolver and
 * AiTaskDefaultServiceModule for the models.* task-default resolver.
 *
 * Also hosts the registry WRITE lane
 * (`SettingsRegistryWriteService`), and enforces the kill-switch governance
 * invariant AT BOOT rather than only in a unit test.
 */
@Module({
  imports: [ConfigResolverModule, AiTaskDefaultServiceModule, CommonServiceModule, GlobalSettingServiceModule],
  providers: [EffectiveSettingsService, SettingsRegistryWriteService],
  exports: [EffectiveSettingsService, SettingsRegistryWriteService],
})
export class EffectiveSettingsModule implements OnModuleInit {
  private readonly logger = new Logger(EffectiveSettingsModule.name);

  /**
   * Governance invariant: an ENFORCING kill-switch must default OFF, so a
   * half-rolled-out enforcement path can never be live-by-accident.
   * `SettingsRegistry.killSwitches()` asserts this, but only ever from a
   * unit test, so a default-ON flip would ship and only fail CI. Calling
   * it here makes a violation refuse BOOT.
   */
  onModuleInit(): void {
    const switches = HOPE_SETTINGS_REGISTRY.killSwitches();
    this.logger.log(`Settings registry: ${HOPE_SETTINGS_REGISTRY.size} descriptor(s), ` + `${switches.length} kill-switch(es), all defaulting OFF.`);
  }
}
