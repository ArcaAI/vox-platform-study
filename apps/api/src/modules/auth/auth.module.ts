import { AuthServiceModule, UserDepartmentServiceModule, UserRoleAssignmentServiceModule, UserServiceModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { AdminImpersonationController } from './admin-impersonation.controller';
import { AuthController } from './auth.controller';
import { StreamTicketModule } from './stream-ticket.module';

/**
 * AuthModule - API authentication endpoints
 *
 * Uses AuthServiceModule for JWT/OIDC strategies and IAuthService.
 * Uses UserServiceModule for IUserService.
 * TASK-307 W6.1 — UserRoleAssignmentServiceModule replaces the previous
 * direct Prisma access in `AuthController` (audit C-10); `CoreDatabaseModule`
 * is still imported because the controller continues to use the User /
 * Tenant / Role repositories for login lookups.
 *
 * StreamTicketModule (TASK-263 W0-1) is `@Global`. Importing it here
 * triggers its initialisation so that `JwtAuthGuard` (registered globally
 * in `JwtAuthGuardModule`) can resolve `StreamTicketService` for the
 * `?ticket=` SSE auth fallback, and so `AuthController` can issue tickets.
 *
 * Note: JWT_AUTH_GUARD is registered globally in AppModule so that
 * UnifiedAuthGuard can resolve it across all feature modules.
 */
@Module({
  imports: [
    AuthServiceModule,
    UserServiceModule,
    UserRoleAssignmentServiceModule,
    UserDepartmentServiceModule,
    CoreDatabaseModule,
    StreamTicketModule,
  ],
  // TASK-401 — AdminImpersonationController adds the global-admin-only
  // `POST /admin/users/:id/impersonate` mint alongside the legacy
  // `/auth/impersonate` route (same module: it reuses the exact same
  // service/repository set the AuthController already wires).
  controllers: [AuthController, AdminImpersonationController],
})
export class AuthModule {}
