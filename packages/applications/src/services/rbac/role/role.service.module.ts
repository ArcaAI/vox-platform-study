import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { AuthorizationModule } from '../../../authorization/authorization.module';
import { IRbacRoleService } from './IRoleService';
import { RbacRoleService } from './role.service';

/**
 * TASK-307 W6.3 — DI module for `RbacRoleService`. Exports the
 * `IRbacRoleService` token so `RolesController` (and any future caller)
 * can depend on the interface, not the concrete class.
 *
 * Named `RbacRoleServiceModule` to disambiguate from the legacy
 * `services/security/role/RoleServiceModule`, which is unused by the API
 * gateway today but still occupies the `RoleServiceModule` symbol in the
 * `@arcaai/applications` barrel.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AuthorizationModule],
  providers: [
    {
      provide: IRbacRoleService,
      useClass: RbacRoleService,
    },
  ],
  exports: [IRbacRoleService],
})
export class RbacRoleServiceModule {}
