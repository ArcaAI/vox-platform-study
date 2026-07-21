import { Module } from '@nestjs/common';
import { CoreDatabaseModule, PolicyRepository, RbacRoleRepository, RolePolicyRepository } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { IRbacRoleService } from './IRoleService';
import { RbacRoleService } from './role.service';

/**
 * DI module for `RbacRoleService`. Exports the
 * `IRbacRoleService` token so `RolesController` (and any future caller)
 * can depend on the interface, not the concrete class.
 *
 * Named `RbacRoleServiceModule` to disambiguate from the legacy
 * `services/security/role/RoleServiceModule`, which is unused by the API
 * gateway today but still occupies the `RoleServiceModule` symbol in the
 * `@arcaai/applications` barrel.
 *
 * `RbacRoleRepository` + `RolePolicyRepository`
 * registered here rather than in `CoreDatabaseModule` (out-of-scope
 * file). `CoreDatabaseModule` is still imported so the
 * `'CORE_DATABASE_SERVICE'` token both repositories inject is in scope.
 *
 * Break-glass needs `ICryptoService` (via CryptoServiceModule) +
 * `UserRepository` (via CoreDatabaseModule) + `PolicyRepository` (detach
 * target lookup / protected-policy detach block, registered here rather than
 * in the owning module).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AuthorizationModule, CryptoServiceModule],
  providers: [
    RbacRoleRepository,
    RolePolicyRepository,
    PolicyRepository,
    {
      provide: IRbacRoleService,
      useClass: RbacRoleService,
    },
  ],
  exports: [IRbacRoleService],
})
export class RbacRoleServiceModule {}
