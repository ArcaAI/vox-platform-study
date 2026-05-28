import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { IPolicyService } from './IPolicyService';
import { PolicyService } from './policy.service';

/**
 * TASK-307 W6.2 — DI module for `PolicyService`. Exports the
 * `IPolicyService` token so `PoliciesController` (and any future
 * caller) can depend on the interface, not the concrete class.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AuthorizationModule],
  providers: [
    {
      provide: IPolicyService,
      useClass: PolicyService,
    },
  ],
  exports: [IPolicyService],
})
export class PolicyServiceModule {}
