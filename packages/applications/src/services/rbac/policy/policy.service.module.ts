import { Module } from '@nestjs/common';
import { CoreDatabaseModule, PolicyRepository, RolePolicyRepository } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
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
 *
 * TASK-409 — break-glass needs `ICryptoService` (bcrypt step-up verify, via
 * CryptoServiceModule) + `UserRepository` (via CoreDatabaseModule) +
 * `RolePolicyRepository` (multi-role blast-radius count, registered here per
 * the TASK-311 D-3 pattern).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AuthorizationModule, CryptoServiceModule],
  providers: [
    PolicyRepository,
    RolePolicyRepository,
    {
      provide: IPolicyService,
      useClass: PolicyService,
    },
  ],
  exports: [IPolicyService],
})
export class PolicyServiceModule {}
