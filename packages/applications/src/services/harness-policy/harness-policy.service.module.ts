import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessPolicyService } from './harness-policy.service';

/**
 * HarnessPolicyService DI module (TASK-330 Phase 6). Imports CoreDatabaseModule
 * for the HarnessPolicy + HarnessPolicyChange repositories and the
 * `CORE_DATABASE_SERVICE` (interactive transactions). `ClsService` is resolved
 * from the globally-registered `ClsModule`.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [HarnessPolicyService],
  exports: [HarnessPolicyService],
})
export class HarnessPolicyServiceModule {}
