import { Module } from '@nestjs/common';
import { CoreDatabaseModule, PolicyRepository, RolePolicyRepository } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { IPolicyService } from './IPolicyService';
import { PolicyService } from './policy.service';

/**
 * DI module for `PolicyService`. Exports the
 * `IPolicyService` token so `PoliciesController` (and any future
 * caller) can depend on the interface, not the concrete class.
 *
 * `PolicyRepository` is registered here rather than
 * in `packages/domains/src/common/databaseServices/core/core.database.module.ts`
 * to avoid editing that shared module. `CoreDatabaseModule` is still imported
 * so the `'CORE_DATABASE_SERVICE'` token the repository injects is in scope.
 *
 * Break-glass needs `ICryptoService` (bcrypt step-up verify, via
 * CryptoServiceModule) + `UserRepository` (via CoreDatabaseModule) +
 * `RolePolicyRepository` (multi-role blast-radius count, registered here
 * rather than in the owning module).
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
