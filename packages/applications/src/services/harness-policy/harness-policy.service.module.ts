import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AiTaskDefaultServiceModule } from '../ai-task-default/ai-task-default.service.module';
import { HarnessPolicyService } from './harness-policy.service';

/**
 * HarnessPolicyService DI module (TASK-330 Phase 6). Imports CoreDatabaseModule
 * for the HarnessPolicy + HarnessPolicyChange repositories and the
 * `CORE_DATABASE_SERVICE` (interactive transactions). `ClsService` is resolved
 * from the globally-registered `ClsModule`.
 *
 * TASK-511 (Phase 3A) — imports AiTaskDefaultServiceModule so `IAiTaskDefaultService`
 * is available for the AiTaskDefault-first SMR routing precedence in
 * `resolveSmrSelection` (the injection is @Optional, so this is additive).
 */
@Module({
  imports: [CoreDatabaseModule, AiTaskDefaultServiceModule],
  providers: [HarnessPolicyService],
  exports: [HarnessPolicyService],
})
export class HarnessPolicyServiceModule {}
