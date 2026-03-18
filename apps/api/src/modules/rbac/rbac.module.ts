import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
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
 */
@Module({
    imports: [
        CoreDatabaseModule,
    ],
    controllers: [
        RolesController,
        PoliciesController,
        PermissionCheckController,
    ],
})
export class RbacModule {}
