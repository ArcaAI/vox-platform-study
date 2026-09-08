import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { GlobalSettingServiceModule } from '../globalSetting/globalSetting.service.module';
import { PlatformStorageSettingsResolver } from '../tenant-storage-config/platform-storage-settings.resolver';
import { EffectiveSettingsService } from './effective-settings.service';
import { FeatureAvailabilityService } from './feature-availability.service';
import { HOPE_SETTINGS_REGISTRY } from './registry';
import { SettingsRegistryWriteService } from './settings-registry-write.service';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * DI module for the EffectiveSettingsService facade. The `models.*` (TASK-881) and
 * `pipeline.*` (TASK-882) lanes are gone: model selection resolves through
 * `AiRoutingPolicyService`, workflow toggles through the assigned graph.
 *
 * Also hosts the registry WRITE lane
 * (`SettingsRegistryWriteService`), and enforces the kill-switch governance
 * invariant AT BOOT rather than only in a unit test.
 */
@Module({
  // `CoreDatabaseModule` supplies `TenantStorageConfigRepository`, the ONLY new
  // dependency the `db-config` lane needs — the cascade itself is the pure
  // function the upload path already uses.
  imports: [CommonServiceModule, GlobalSettingServiceModule, CoreDatabaseModule],
  providers: [EffectiveSettingsService, SettingsRegistryWriteService, TenantSettingsService, PlatformStorageSettingsResolver, FeatureAvailabilityService],
  exports: [EffectiveSettingsService, SettingsRegistryWriteService, TenantSettingsService, PlatformStorageSettingsResolver, FeatureAvailabilityService],
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
