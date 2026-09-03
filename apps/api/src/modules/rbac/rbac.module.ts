import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PolicyServiceModule, RbacRoleServiceModule, UserRoleAssignmentServiceModule } from '@arcaai/applications';
import { RolesController } from './roles.controller';
import { PoliciesController } from './policies.controller';
import { PermissionCheckController, UserPermissionCheckController } from './permission-check.controller';
import { PermissionCheckRedirectShimController } from './permission-check-redirect.shim.controller';

/**
 * RBAC Module
 *
 * Provides endpoints for managing roles, policies, and checking permissions.
 *
 * Endpoints:
 * - GET/POST/PUT/DELETE /rbac/roles - Role management
 * - POST/DELETE /rbac/roles/:roleId/policies/:policyId - Role-Policy assignments
 * - GET/POST/PUT/DELETE /rbac/policies - Policy management
 * - POST /rbac/policies/validate - Validate policy rules
 * - POST /users/:id/permission-checks - Check single permission
 * - POST /users/:id/permission-checks/bulk - Check multiple permissions
 * - POST /users/me/permission-checks - Get current user's permissions
 *
 * `PolicyServiceModule` + `RbacRoleServiceModule`
 * are wired so `PoliciesController` and `RolesController` can drop their
 * direct `CoreDatabaseService` dependency.
 */
@Module({
  // `UserRoleAssignmentServiceModule` backs the new
  // `GET admin/rbac/roles/:id/members` listing on `RolesController`.
  imports: [CoreDatabaseModule, PolicyServiceModule, RbacRoleServiceModule, UserRoleAssignmentServiceModule],
  // ORDER IS LOAD-BEARING. `PermissionCheckController`
  // (`users/me/permission-checks`, a LITERAL segment) must precede
  // `UserPermissionCheckController` (`users/:id/permission-checks`), or the
  // `:id` parameter swallows `me` and every self permission check silently
  // resolves to the by-id handler. Pinned by
  // `src/modules/user/controllers/__tests__/users-me-route-precedence.test.ts`.
  controllers: [RolesController, PoliciesController, PermissionCheckController, UserPermissionCheckController, PermissionCheckRedirectShimController],
})
export class RbacModule {}
