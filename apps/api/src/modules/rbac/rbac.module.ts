import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PolicyServiceModule, RbacRoleServiceModule, UserRoleAssignmentServiceModule } from '@arcaai/applications';
import { RolesController } from './roles.controller';
import { PoliciesController } from './policies.controller';
import { PermissionCheckController } from './permission-check.controller';

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
 * - POST /rbac/check - Check single permission
 * - POST /rbac/check/bulk - Check multiple permissions
 * - POST /rbac/check/my-permissions - Get current user's permissions
 *
 * TASK-307 W6.2 / W6.3 — `PolicyServiceModule` + `RbacRoleServiceModule`
 * are wired so `PoliciesController` and `RolesController` can drop their
 * direct `CoreDatabaseService` dependency (closes audit C-10 / F-1 /
 * H-9).
 */
@Module({
  // TASK-444 — `UserRoleAssignmentServiceModule` backs the new
  // `GET admin/rbac/roles/:id/members` listing on `RolesController`.
  imports: [CoreDatabaseModule, PolicyServiceModule, RbacRoleServiceModule, UserRoleAssignmentServiceModule],
  controllers: [RolesController, PoliciesController, PermissionCheckController],
})
export class RbacModule {}
