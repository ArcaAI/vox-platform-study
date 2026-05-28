import { Module } from '@nestjs/common';
import { CoreDatabaseModule, PolicyRepository } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { IPolicyService } from './IPolicyService';
import { PolicyService } from './policy.service';

/**
 * TASK-307 W6.2 — DI module for `PolicyService`. Exports the
 * `IPolicyService` token so `PoliciesController` (and any future
 * caller) can depend on the interface, not the concrete class.
 *
 * TASK-311 (D-3) — `PolicyRepository` is registered here rather than
 * in `CoreDatabaseModule` because the per-ticket scope locks
 * `packages/domains/src/common/databaseServices/core/core.database.module.ts`
 * out of edits. `CoreDatabaseModule` is still imported so the
 * `'CORE_DATABASE_SERVICE'` token the repository injects is in scope.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AuthorizationModule],
  providers: [
    PolicyRepository,
    {
      provide: IPolicyService,
      useClass: PolicyService,
    },
  ],
  exports: [IPolicyService],
})
export class PolicyServiceModule {}
