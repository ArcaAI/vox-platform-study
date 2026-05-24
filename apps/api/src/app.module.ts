import {
  AuditLogServiceModule,
  AuthServiceModule,
  AuthorizationModule,
  CommonServiceModule,
  ConfigModule,
  JWT_AUTH_GUARD,
  LoggingServiceModule,
  ObservabilityModule,
  RedisServiceModule,
  SysEventServiceModule,
} from '@arcaai/applications';
import { JobQueue } from '@arcaai/domains';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RequiresIfMatchGuard } from './decorators/requiresIfMatch.guard';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';
import { JwtAuthGuard } from './guards';
import { ContextInterceptor, ExceptionInterceptor, ImpersonationAuditInterceptor, MaintenanceInterceptor, MetricsInterceptor } from './interceptors';
import { GracefulShutdownModule } from './services';
import { VaultPrismaFactoryModule } from './vault-prisma.module';
import { VaultRotationWorkerModule } from './workers/vault-rotation.worker.module';

// Feature modules
import { ApiKeyModule } from './modules/api-key/api-key.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConsultationModule } from './modules/consultation/consultation.module';
import { DepartmentModule } from './modules/department/department.module';
import { DnaWritingStyleModule } from './modules/dna-writing-style/dna-writing-style.module';
import { HealthModule } from './modules/health/health.module';
import { InternalModule } from './modules/internal/internal.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { PromptManagementModule } from './modules/prompt-management/prompt-management.module';
import { PrismaStudioModule } from './modules/pstudio/pstudio.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { StorageAccessKeyModule } from './modules/storage-access-key/storage-access-key.module';
import { StorageModule } from './modules/storage/storage.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { TenantBucketModule } from './modules/tenant-bucket/tenant-bucket.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';
import { VoiceProfileModule } from './modules/voice-profile/voice-profile.module';

const interceptors = [
  {
    provide: APP_INTERCEPTOR,
    useClass: MetricsInterceptor,
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: ContextInterceptor,
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: ExceptionInterceptor,
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: MaintenanceInterceptor,
  },
  {
    provide: APP_INTERCEPTOR,
    useClass: ImpersonationAuditInterceptor,
  },
];

// TASK-302 Stream D Phase D (D.2) — global guard that propagates the
// `@RequiresIfMatch()` marker onto `req._requiresIfMatch`. The companion
// `@ExpectedVersion()` param decorator then throws `428 Precondition
// Required` if the inbound `If-Match` header is absent on an annotated
// route. Non-annotated routes pay only one `Reflector.getAllAndOverride`
// call per request — effectively free.
const guards = [
  {
    provide: APP_GUARD,
    useClass: RequiresIfMatchGuard,
  },
];

// Define all queue names to be used in the application
const queueNames = Object.values(JobQueue);

/**
 * JwtAuthGuardModule — registers JWT_AUTH_GUARD globally so that
 * UnifiedAuthGuard (in AuthorizationModule) can resolve it across
 * every feature module that uses @Authorize().
 *
 * Must be listed BEFORE AuthorizationModule in the imports array
 * so the guard token is available when UnifiedAuthGuard is created.
 */
@Global()
@Module({
  imports: [AuthServiceModule],
  providers: [{ provide: JWT_AUTH_GUARD, useClass: JwtAuthGuard }],
  exports: [JWT_AUTH_GUARD, AuthServiceModule],
})
class JwtAuthGuardModule {}

const common = [
  LoggingServiceModule, // Add the logger service
  GracefulShutdownModule, // Graceful shutdown coordination
  ConfigModule.forRoot(),
  ClsModule.forRoot({
    global: true,
    middleware: {
      mount: true,
      generateId: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      idGenerator: (req: any) => req.headers['X-Request-Id'] ?? uuidv7(),
    },
  }),
  ScheduleModule.forRoot(),
  EventEmitterModule.forRoot(),
  SysEventServiceModule,
  CommonServiceModule,
  RedisServiceModule.register(queueNames),
  ObservabilityModule,
  AuditLogServiceModule, // Event-driven audit logging (replaces Kafka audit topics)
  JwtAuthGuardModule, // JWT guard — before AuthorizationModule
  AuthorizationModule, // Policy-based authorization (RBAC)
  // TASK-302 Phase 5 Task 5.6 (Stream B) — Vault prisma factory.
  // Self-guards via SECRETS_PROVIDER=vault + PG_DYNAMIC_CREDS=true,
  // so it's safe to import unconditionally; when off it provides a
  // `null`-returning factory that CoreDatabaseService's @Optional
  // inject treats as absent.
  VaultPrismaFactoryModule,
  // TASK-302 Phase 6 Task 6.5 (Stream B) — Vault rotation worker.
  // Self-guards via SECRETS_PROVIDER=vault + VAULT_AUDIT_LOG_PATH +
  // Redis leader-lock, so it's safe to import unconditionally.
  VaultRotationWorkerModule,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const featureModules: any[] = [
  ApiKeyModule,
  AuthModule,
  AuditLogModule,
  ConsultationModule,
  DepartmentModule,
  DnaWritingStyleModule,
  HealthModule,
  InternalModule,
  MonitoringModule,
  PromptManagementModule,
  RbacModule,
  StorageModule,
  StorageAccessKeyModule,
  StreamingModule,
  PipelineModule,
  TenantModule,
  TenantBucketModule,
  UserModule,
  VoiceProfileModule,
];

// Dev-only: Embedded Prisma Studio database browser at /api/pstudio
const enableStudio =
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  process.env.ENABLE_PRISMA_STUDIO === 'true' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_PRISMA_STUDIO !== 'false');
if (enableStudio) {
  featureModules.push(PrismaStudioModule);
}

@Module({
  imports: [...common, ...featureModules],
  providers: [...interceptors, ...guards],
})
export class AppModule {}
