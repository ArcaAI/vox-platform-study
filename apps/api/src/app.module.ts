import {
  AuditLogServiceModule,
  AuditRetentionServiceModule,
  AuthServiceModule,
  AuthorizationModule,
  BlobStorageModule,
  CommonServiceModule,
  ConfigModule,
  EntitlementsServiceModule,
  JWT_AUTH_GUARD,
  KnowledgeServiceModule,
  LoggingServiceModule,
  ObservabilityModule,
  RateLimitServiceModule,
  RedisServiceModule,
  SysEventServiceModule,
  UnifiedAuthGuard,
} from '@arcaai/applications';
import { JobQueue } from '@arcaai/domains';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RequiresIfMatchGuard } from './decorators/requiresIfMatch.guard';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';
import { DataNotFoundExceptionFilter } from './filters';
import { JwtAuthGuard } from './guards';
import { ContextInterceptor, ExceptionInterceptor, ImpersonationAuditInterceptor, MaintenanceInterceptor, MetricsInterceptor } from './interceptors';
import { TenantOwnedResourceModule, TenantOwnedResourceSseGuard } from './common';
import { GracefulShutdownModule } from './services';
import { TenantContextProviderModule } from './database/tenant-context.provider';
import { VaultPrismaFactoryModule } from './vault-prisma.module';
import { VaultRotationWorkerModule } from './workers/vault-rotation.worker.module';
import { ThrottleConfigModule, TieredThrottlerGuard } from './modules/throttle';

// Feature modules
import { RateLimitAdminModule } from './modules/admin-rate-limit/rate-limit-admin.module';
// TASK-419 item 3 — /admin/ai-services read-only Guardrail/NLP proxy plane.
import { AiInferenceModule } from './modules/ai-inference/ai-inference.module';
import { AiServiceAdminModule } from './modules/ai-service-admin/ai-service-admin.module';
import { ApiKeyModule } from './modules/api-key/api-key.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
// TASK-390 #24 (ST1) — /admin/settings global-settings CRUD (global-admin tier).
import { GlobalSettingModule } from './modules/global-setting/global-setting.module';
import { ConsultationModule } from './modules/consultation/consultation.module';
import { DepartmentModule } from './modules/department/department.module';
import { DnaWritingStyleModule } from './modules/dna-writing-style/dna-writing-style.module';
import { EntitlementsApiModule } from './modules/entitlements/entitlements.module';
// TASK-330 Phase 6 — harness administration & observability console (/admin/harness/*).
import { HarnessAdminModule } from './modules/harness-admin/harness-admin.module';
// TASK-356 Phase 5 — realtime-pipeline toggle cascade admin (/admin/harness/pipeline-policy).
import { PipelinePolicyAdminModule } from './modules/pipeline-policy-admin/pipeline-policy-admin.module';
import { TenantTtsConfigModule } from './modules/tenant-tts-config/tenant-tts-config.module';
import { HealthModule } from './modules/health/health.module';
import { InternalModule } from './modules/internal/internal.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
// TASK-419 item 2 — /admin/notifications (read/update/delete over system-emitted rows).
import { NotificationModule } from './modules/notification/notification.module';
import { PlatformMetricsModule } from './modules/platform-metrics/platform-metrics.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { AiModelModule } from './modules/ai-model/ai-model.module';
import { PromptManagementModule } from './modules/prompt-management/prompt-management.module';
import { PrismaStudioModule, shouldEnablePrismaStudio } from './modules/pstudio/pstudio.module';
import { PrismaStudioStatusModule } from './modules/pstudio/pstudio-status.module';
import { QueueAdminModule } from './modules/queue-admin/queue-admin.module';
import { RbacModule } from './modules/rbac/rbac.module';
// TASK-419 item 2 — /admin/resource-subscriptions (CRUD + toggle).
import { ResourceSubscriptionModule } from './modules/resource-subscription/resource-subscription.module';
import { StorageAccessKeyModule } from './modules/storage-access-key/storage-access-key.module';
import { StorageModule } from './modules/storage/storage.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { SpeechModule } from './modules/speech/speech.module';
import { TenantBucketModule } from './modules/tenant-bucket/tenant-bucket.module';
import { TenantFrontendConfigModule } from './modules/tenant-frontend-config/tenant-frontend-config.module';
import { TenantStorageConfigModule } from './modules/tenant-storage-config/tenant-storage-config.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';
import { VoiceProfileModule } from './modules/voice-profile/voice-profile.module';
// TASK-419 item 2 — /admin/webhooks (CRUD + delivery-log reads).
import { WebhookModule } from './modules/webhook/webhook.module';

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

// Guards execute in declaration order. UnifiedAuthGuard MUST come first
// so authentication is established before any concurrency / ownership
// check that depends on the resolved CLS user / tenant context.
//
// TASK-307 W4b (AC-13, audit C-7 part 2) — register UnifiedAuthGuard as
// APP_GUARD so the application default is deny. `@Public()` is the
// explicit opt-out (read via SKIP_AUTH_KEY metadata); `@Authorize()` /
// `@CanXxx()` decorators continue to gate per-route authorization on
// top of the unified auth pass.
//
// TASK-302 Stream D Phase D (D.2) — global guard that propagates the
// `@RequiresIfMatch()` marker onto `req._requiresIfMatch`. The companion
// `@ExpectedVersion()` param decorator then throws `428 Precondition
// Required` if the inbound `If-Match` header is absent on an annotated
// route. Non-annotated routes pay only one `Reflector.getAllAndOverride`
// call per request — effectively free.
const guards = [
  // TASK-315 — TieredThrottlerGuard runs FIRST (before auth resolution) so
  // brute-force / DoS protection rejects abusive traffic before the heavier
  // authentication + tenant/CLS resolution work executes. Only the `default`
  // tier gates every route; strict/heavy/relaxed are opt-in per route.
  {
    provide: APP_GUARD,
    useClass: TieredThrottlerGuard,
  },
  {
    provide: APP_GUARD,
    useClass: UnifiedAuthGuard,
  },
  // TASK-309 — runs AFTER UnifiedAuthGuard so the CLS tenantId is populated.
  // Closes the @Sse() cross-tenant leak: the global
  // TenantOwnedResourceInterceptor throws 404 too late for SSE (the stream has
  // already opened), so this guard re-runs the ownership assertion BEFORE the
  // handler executes. No-op on every non-SSE route.
  {
    provide: APP_GUARD,
    useClass: TenantOwnedResourceSseGuard,
  },
  {
    provide: APP_GUARD,
    useClass: RequiresIfMatchGuard,
  },
];

// TASK-306 W5.5.4 / P3.3 / AC-12 (closes audit M-8) — global exception
// filter that maps `DataNotFoundException` (thrown by
// `Repository<T>.findById` and friends) to a generic
// `404 { message: "Resource not found" }` response, dropping the model
// name + row id from the body. Scoped ONLY to `DataNotFoundException`
// per the user-locked decision in plan README §10 Q2: the W5.1.3 /
// W5.2 / W5.3 service-layer guards already throw
// `NotFoundException("Resource not found")` directly with the right
// message and need no filter wrapping.
const filters = [
  {
    provide: APP_FILTER,
    useClass: DataNotFoundExceptionFilter,
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
  // TASK-315 — registers the global ThrottlerModule (named throttlers + Redis/
  // in-memory storage) and exports TieredThrottlerGuard so the APP_GUARD wired
  // in `guards[]` below can be constructed via DI. Placed early so the guard's
  // dependencies resolve before the feature modules load.
  ThrottleConfigModule,
  // TASK-316 — DB-backed rate-limit settings. Exports IRateLimitSettingsService
  // so the TieredThrottlerGuard (APP_GUARD above) resolves live limits from the
  // GlobalSetting cache, and IRateLimitAdminService for the admin endpoint.
  RateLimitServiceModule,
  // TASK-392 (Q7) — exports IEntitlementsService so the TieredThrottlerGuard
  // (APP_GUARD above) can resolve per-tenant plan rate-limit tiers on the hot
  // path. Placed alongside RateLimitServiceModule (its sibling guard dep).
  EntitlementsServiceModule,
  ScheduleModule.forRoot(),
  EventEmitterModule.forRoot(),
  SysEventServiceModule,
  CommonServiceModule,
  // TASK-318 R5 — @Global() provider-agnostic blob storage. Registered once
  // here (after CommonServiceModule provides AppSettings) so there is exactly
  // ONE BlobStorageProviderFactory app-wide; required for tenant provider-cache
  // coherence between the read path and TenantStorageConfigService.invalidate().
  BlobStorageModule.forRoot(),
  RedisServiceModule.register(queueNames),
  ObservabilityModule,
  AuditLogServiceModule, // Event-driven audit logging (replaces Kafka audit topics)
  AuditRetentionServiceModule, // TASK-336 OB-05 — scheduled AuditLog retention purge (bounds growth)
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
  // TASK-305 Phase B.7 — Wires ClsService → tenantScopeFilter Prisma
  // extension at app bootstrap. Until this module is loaded, the
  // extension treats every query as global-admin pass-through (the
  // safe default for CLI / seed scripts that run without CLS).
  TenantContextProviderModule,
  // TASK-307 W3.2 — Registers the global TenantOwnedResourceInterceptor as
  // APP_INTERCEPTOR. Runs AFTER the existing auth chain so the CLS
  // tenantId is already populated. The interceptor is a no-op for any
  // handler not annotated with `@TenantOwnedResource(...)`.
  TenantOwnedResourceModule,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const featureModules: any[] = [
  RateLimitAdminModule,
  AiServiceAdminModule,
  AiInferenceModule,
  ApiKeyModule,
  AuthModule,
  AuditLogModule,
  ConsultationModule,
  DepartmentModule,
  DnaWritingStyleModule,
  // TASK-392 (Phase 4) — /admin/entitlements/* (global-admin matrix/override/kill-switch/downgrade)
  // + /entitlements/me (tenant self-snapshot). All entitlements endpoints live here.
  EntitlementsApiModule,
  // TASK-390 #24 — /admin/settings (global-settings CRUD; wires the existing service).
  GlobalSettingModule,
  // TASK-330 Phase 3 — institutional-RAG knowledge ingestion (BullMQ worker;
  // registers the IngestKnowledgeDocument queue + processor). Worker-only — no
  // REST controllers in this phase.
  KnowledgeServiceModule,
  HealthModule,
  InternalModule,
  MonitoringModule,
  // TASK-419 item 2 — /admin/notifications (read/update/delete; no admin POST).
  NotificationModule,
  // TASK-386 (#16) — /admin/platform/{metrics,sockets,consumption} (global-admin).
  PlatformMetricsModule,
  PromptManagementModule,
  // TASK-330 Phase 6 — /admin/harness/* (policy, observe, workflow ops).
  HarnessAdminModule,
  // TASK-356 Phase 5 — /admin/harness/pipeline-policy (realtime-toggle cascade admin).
  PipelinePolicyAdminModule,
  // TASK-496 — /admin/tts-config (per-tenant TTS spec + BYO provider credentials).
  TenantTtsConfigModule,
  QueueAdminModule,
  // TASK-403 — always-on availability probe for the dev-only Prisma Studio
  // shell (the shell module below stays conditionally registered).
  PrismaStudioStatusModule,
  RbacModule,
  // TASK-419 item 2 — /admin/resource-subscriptions (CRUD + toggle).
  ResourceSubscriptionModule,
  StorageModule,
  StorageAccessKeyModule,
  StreamingModule,
  SpeechModule,
  PipelineModule,
  AiModelModule,
  TenantModule,
  TenantBucketModule,
  TenantStorageConfigModule,
  TenantFrontendConfigModule,
  UserModule,
  VoiceProfileModule,
  // TASK-419 item 2 — /admin/webhooks (CRUD + delivery-log reads).
  WebhookModule,
];

// TASK-419 item 4 (supersedes TASK-307 W5.2): Embedded Prisma Studio is
// production-capable but fail-closed — the module registers only when the
// operator explicitly sets ENABLE_PRISMA_STUDIO=true, and every route is
// additionally guarded by the dedicated `manage:PrismaStudio` permission.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (shouldEnablePrismaStudio({ NODE_ENV: process.env.NODE_ENV, ENABLE_PRISMA_STUDIO: process.env.ENABLE_PRISMA_STUDIO })) {
  featureModules.push(PrismaStudioModule);
}

@Module({
  imports: [...common, ...featureModules],
  providers: [...interceptors, ...guards, ...filters],
})
export class AppModule {}
