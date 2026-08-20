import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { HarnessPolicyService } from './harness-policy.service';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';

/**
 * HarnessPolicyService DI module. Imports CoreDatabaseModule
 * for the HarnessPolicy + HarnessPolicyChange repositories and the
 * `CORE_DATABASE_SERVICE` (interactive transactions). `ClsService` is resolved
 * from the globally-registered `ClsModule`.
 *
 * imports AiTaskDefaultServiceModule so `IAiTaskDefaultService`
 * is available for the AiTaskDefault-first TEXT routing precedence in
 * `resolveTextSelection` (the injection is @Optional, so this is additive).
 */
@Module({
  // EffectiveSettingsModule supplies the settings-registry read
  // facade so the effective policy can carry `agentic.context.tokenBudget.perRun`
  // to the worker in the single policy fetch it already makes.
  imports: [CoreDatabaseModule, AiTaskDefaultServiceModule, EffectiveSettingsModule],
  providers: [HarnessPolicyService],
  exports: [HarnessPolicyService],
})
export class HarnessPolicyServiceModule {}
