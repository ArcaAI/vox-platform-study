import {
  AuthServiceModule,
  EffectiveSettingsModule,
  FederatedAuthServiceModule,
  RegistrationServiceModule,
  UserDepartmentServiceModule,
  UserRoleAssignmentServiceModule,
  UserServiceModule,
  WorkflowRunServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TenantOwnedResourceModule } from '../../common';
import { AdminImpersonationController } from './admin-impersonation.controller';
import { AuthController } from './auth.controller';
import { AuthSsoController } from './auth-sso.controller';
import { RegisterController } from './register.controller';
import { StreamTicketModule } from './stream-ticket.module';

/**
 * AuthModule - API authentication endpoints
 *
 * Uses AuthServiceModule for JWT/OIDC strategies and IAuthService.
 * Uses UserServiceModule for IUserService.
 * UserRoleAssignmentServiceModule replaces the previous
 * direct Prisma access in `AuthController`; `CoreDatabaseModule`
 * is still imported because the controller continues to use the User /
 * Tenant / Role repositories for login lookups.
 *
 * StreamTicketModule is `@Global`. Importing it here
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
    // Exposes `StreamSessionTenantBindingService` so the
    // stream-ticket mint can 404 `stt_session:*` scopes whose session is not
    // bound to the caller's tenant AND user (same instance the WS gateway and
    // the DELETE-route interceptor consult). NestJS dedupes the module instance
    // with the AppModule/StreamingModule imports.
    TenantOwnedResourceModule,
    // FederatedAuthService (OIDC login round-trip + JIT provisioning).
    FederatedAuthServiceModule,
    // RegistrationService (verified self-signup) for RegisterController.
    RegistrationServiceModule,
    // TASK-932 D-4 - `TenantSettingsService`, so `RegisterController` resolves
    // `registration.selfSignupEnabled` from the `global-kv` tier instead of the
    // retired `REGISTRATION_SELF_SIGNUP_ENABLED` env read. NestJS dedupes the
    // module instance with the AppModule import.
    EffectiveSettingsModule,
    // Mint-time tenant-ownership check for `workflow_run:<runId>` tickets
    // `IWorkflowRunService.getRun` already 404s a foreign-tenant runId; reused here rather than
    // adding a second lookup path.
    WorkflowRunServiceModule,
    // Finding H-02 — the DNA generation queue, so the stream-ticket mint can
    // assert `dna_job:<jobId>` ownership from the job payload before issuing.
    BullModule.registerQueue({ name: JobQueue.GenerateDnaReport }),
  ],
  // AdminImpersonationController adds the super-admin-only
  // `POST /admin/users/:id/impersonate` mint alongside the legacy
  // `/auth/impersonate` route (same module: it reuses the exact same
  // service/repository set the AuthController already wires).
  // AuthSsoController adds `/auth/sso/{start,callback}`, reusing
  // the same createJwt/RefreshTokenService mint path as AuthController.login.
  // RegisterController adds `/auth/register` + `/auth/register/verify`.
  controllers: [AuthController, AdminImpersonationController, AuthSsoController, RegisterController],
})
export class AuthModule {}
