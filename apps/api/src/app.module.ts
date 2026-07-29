import {
  AgentTrajectoryRetentionServiceModule,
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
import { ClsGuard, ClsModule } from 'nestjs-cls';
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
// /admin/ai-services read-only Guardrail/NLP proxy plane.
import { AiInferenceModule } from './modules/ai-inference/ai-inference.module';
import { AiProviderConnectionModule } from './modules/ai-provider-connection/ai-provider-connection.module';
import { AiRuntimeProfileModule } from './modules/ai-runtime-profile/ai-runtime-profile.module';
import { AiTaskDefaultModule } from './modules/ai-task-default/ai-task-default.module';
import { AiServiceAdminModule } from './modules/ai-service-admin/ai-service-admin.module';
import { ApiKeyModule } from './modules/api-key/api-key.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
// /admin/settings global-settings CRUD (global-admin tier).
import { GlobalSettingModule } from './modules/global-setting/global-setting.module';
// /admin/settings/catalog capability inventory (registered
// BEFORE GlobalSettingModule so the static route wins over admin/settings/:id).
import { PlatformKnobsModule } from './modules/platform-knobs/platform-knobs.module';
import { SettingsCatalogModule } from './modules/settings-catalog/settings-catalog.module';
import { ConsultationModule } from './modules/consultation/consultation.module';
import { DepartmentModule } from './modules/department/department.module';
import { DepartmentAgentModule } from './modules/department-agent/department-agent.module';
import { DnaWritingStyleModule } from './modules/dna-writing-style/dna-writing-style.module';
import { EntitlementsApiModule } from './modules/entitlements/entitlements.module';
// harness administration & observability console (/admin/harness/*).
import { HarnessAdminModule } from './modules/harness-admin/harness-admin.module';
// ordered agentic-session trajectory read plane (/admin/agent-trajectory/*).
import { AgentTrajectoryModule } from './modules/agent-trajectory/agent-trajectory.module';
// Phase 3A item 6 — read-only agentic instruction inventory (/admin/agentic/*).
import { AgenticAdminModule } from './modules/agentic-admin/agentic-admin.module';
import { McpAdminModule } from './modules/mcp-admin/mcp-admin.module';
// realtime-pipeline toggle cascade admin (/admin/harness/pipeline-policy).
import { PipelinePolicyAdminModule } from './modules/pipeline-policy-admin/pipeline-policy-admin.module';
import { TenantTtsConfigModule } from './modules/tenant-tts-config/tenant-tts-config.module';
// tenant-scoped STT fallback + BYOK admin surface (/admin/stt-config).
import { TenantSttConfigModule } from './modules/tenant-stt-config/tenant-stt-config.module';
// tenant-scoped external identity provider (OIDC) admin surface.
import { TenantIdpConfigModule } from './modules/tenant-idp-config/tenant-idp-config.module';
import { HealthModule } from './modules/health/health.module';
import { InternalModule } from './modules/internal/internal.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
// /admin/notifications (read/update/delete over system-emitted rows).
import { NotificationModule } from './modules/notification/notification.module';
import { PlatformMetricsModule } from './modules/platform-metrics/platform-metrics.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { AiModelModule } from './modules/ai-model/ai-model.module';
import { PromptManagementModule } from './modules/prompt-management/prompt-management.module';
import { PrismaStudioModule, shouldEnablePrismaStudio } from './modules/pstudio/pstudio.module';
import { PrismaStudioStatusModule } from './modules/pstudio/pstudio-status.module';
import { QueueAdminModule } from './modules/queue-admin/queue-admin.module';
import { RbacModule } from './modules/rbac/rbac.module';
// /admin/resource-subscriptions (CRUD + toggle).
import { ResourceSubscriptionModule } from './modules/resource-subscription/resource-subscription.module';
import { StorageAccessKeyModule } from './modules/storage-access-key/storage-access-key.module';
import { StorageModule } from './modules/storage/storage.module';
import { SmrCompatModule } from './modules/smr-compat/smr-compat.module';
import { SttCompatModule } from './modules/stt-compat/stt-compat.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { SpeechModule } from './modules/speech/speech.module';
import { TenantBucketModule } from './modules/tenant-bucket/tenant-bucket.module';
import { TenantFrontendConfigModule } from './modules/tenant-frontend-config/tenant-frontend-config.module';
import { TenantStorageConfigModule } from './modules/tenant-storage-config/tenant-storage-config.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';
import { VoiceProfileModule } from './modules/voice-profile/voice-profile.module';
// /admin/webhooks (CRUD + delivery-log reads).
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
// UnifiedAuthGuard registers as APP_GUARD so the application default is
// deny. `@Public()` is the explicit opt-out (read via SKIP_AUTH_KEY
// metadata); `@Authorize()` / `@CanXxx()` decorators continue to gate
// per-route authorization on top of the unified auth pass.
//
// RequiresIfMatchGuard is the global guard that propagates the
// `@RequiresIfMatch()` marker onto `req._requiresIfMatch`. The companion
// `@ExpectedVersion()` param decorator then throws `428 Precondition
// Required` if the inbound `If-Match` header is absent on an annotated
// route. Non-annotated routes pay only one `Reflector.getAllAndOverride`
// call per request — effectively free.
const guards = [
  // TieredThrottlerGuard runs FIRST (before auth resolution) so
  // brute-force / DoS protection rejects abusive traffic before the heavier
  // authentication + tenant/CLS resolution work executes. Only the `default`
  // tier gates every route; strict/heavy/relaxed are opt-in per route.
  {
    provide: APP_GUARD,
    useClass: TieredThrottlerGuard,
  },
  {
    provide: APP_GUARD,
    useClass: ClsGuard,
  },
  {
    provide: APP_GUARD,
    useClass: UnifiedAuthGuard,
  },
  // Runs AFTER UnifiedAuthGuard so the CLS tenantId is populated.
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

// Global exception filter that maps `DataNotFoundException` (thrown by
// `Repository<T>.findById` and friends) to a generic
// `404 { message: "Resource not found" }` response, dropping the model
// name + row id from the body. Scoped ONLY to `DataNotFoundException` —
// service-layer guards elsewhere already throw
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
  // Registers the global ThrottlerModule (named throttlers + Redis/
  // in-memory storage) and exports TieredThrottlerGuard so the APP_GUARD wired
  // in `guards[]` below can be constructed via DI. Placed early so the guard's
  // dependencies resolve before the feature modules load.
  ThrottleConfigModule,
  // DB-backed rate-limit settings. Exports IRateLimitSettingsService
  // so the TieredThrottlerGuard (APP_GUARD above) resolves live limits from the
  // GlobalSetting cache, and IRateLimitAdminService for the admin endpoint.
  RateLimitServiceModule,
  // Exports IEntitlementsService so the TieredThrottlerGuard
  // (APP_GUARD above) can resolve per-tenant plan rate-limit tiers on the hot
  // path. Placed alongside RateLimitServiceModule (its sibling guard dep).
  EntitlementsServiceModule,
  ScheduleModule.forRoot(),
  EventEmitterModule.forRoot(),
  SysEventServiceModule,
  CommonServiceModule,
  // @Global() provider-agnostic blob storage. Registered once
  // here (after CommonServiceModule provides AppSettings) so there is exactly
  // ONE BlobStorageProviderFactory app-wide; required for tenant provider-cache
  // coherence between the read path and TenantStorageConfigService.invalidate().
  BlobStorageModule.forRoot(),
  RedisServiceModule.register(queueNames),
  ObservabilityModule,
  AuditLogServiceModule, // Event-driven audit logging (replaces Kafka audit topics)
  AuditRetentionServiceModule, // scheduled AuditLog retention purge (bounds growth)
  AgentTrajectoryRetentionServiceModule, // scheduled AgentTrajectoryStep hard-retention prune (opt-in)
  JwtAuthGuardModule, // JWT guard — before AuthorizationModule
  AuthorizationModule, // Policy-based authorization (RBAC)
  // Vault prisma factory. Self-guards via SECRETS_PROVIDER=vault +
  // PG_DYNAMIC_CREDS=true, so it's safe to import unconditionally; when
  // off it provides a `null`-returning factory that CoreDatabaseService's
  // @Optional inject treats as absent.
  VaultPrismaFactoryModule,
  // Vault rotation worker. Self-guards via SECRETS_PROVIDER=vault +
  // VAULT_AUDIT_LOG_PATH + Redis leader-lock, so it's safe to import
  // unconditionally.
  VaultRotationWorkerModule,
  // Wires ClsService → tenantScopeFilter Prisma
  // extension at app bootstrap. Until this module is loaded, the
  // extension treats every query as global-admin pass-through (the
  // safe default for CLI / seed scripts that run without CLS).
  TenantContextProviderModule,
  // Registers the global TenantOwnedResourceInterceptor as
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
  // /admin/ai-task-defaults (per-tenant default model per AI task key).
  AiTaskDefaultModule,
  // The config-plane core surfaces: /admin/ai-providers
  // (provider endpoints + BYO credentials) and /admin/ai-runtime-profiles
  // (hyperparameter/context/concurrency profiles, global-admin only).
  AiProviderConnectionModule,
  AiRuntimeProfileModule,
  ApiKeyModule,
  AuthModule,
  AuditLogModule,
  ConsultationModule,
  DepartmentModule,
  DepartmentAgentModule,
  DnaWritingStyleModule,
  // /admin/entitlements/* (global-admin matrix/override/kill-switch/downgrade)
  // + /entitlements/me (tenant self-snapshot). All entitlements endpoints live here.
  EntitlementsApiModule,
  // Applies the pre-bootstrap platform knobs (`logLevel`,
  // `corsAllowedOrigins`) from the settings cascade — TASK-558 lane I. No
  // controllers; a binder only.
  PlatformKnobsModule,
  // /admin/settings/catalog. MUST precede GlobalSettingModule
  // so the static `catalog` route registers before `admin/settings/:id`.
  SettingsCatalogModule,
  // /admin/settings (global-settings CRUD; wires the existing service).
  GlobalSettingModule,
  // Institutional-RAG knowledge ingestion (BullMQ worker;
  // registers the IngestKnowledgeDocument queue + processor). Worker-only — no
  // REST controllers in this phase.
  KnowledgeServiceModule,
  HealthModule,
  InternalModule,
  MonitoringModule,
  // /admin/notifications (read/update/delete; no admin POST).
  NotificationModule,
  // /admin/platform/{metrics,sockets,consumption} (global-admin).
  PlatformMetricsModule,
  PromptManagementModule,
  // /admin/harness/* (policy, observe, workflow ops).
  HarnessAdminModule,
  // /admin/agent-trajectory/* (ordered session trajectory read plane).
  AgentTrajectoryModule,
  // Phase 3A item 6 — /admin/agentic/* (read-only effective instruction inventory).
  AgenticAdminModule,
  // /admin/mcp-servers/* (MCP external-tools registry; global-admin CRUD + registry read).
  McpAdminModule,
  // /admin/harness/pipeline-policy (realtime-toggle cascade admin).
  PipelinePolicyAdminModule,
  // /admin/tts-config (per-tenant TTS spec + BYO provider credentials).
  TenantTtsConfigModule,
  TenantSttConfigModule,
  // /admin/tenant-idp-config (tenant-scoped external OIDC identity provider).
  TenantIdpConfigModule,
  QueueAdminModule,
  // Always-on availability probe for the dev-only Prisma Studio
  // shell (the shell module below stays conditionally registered).
  PrismaStudioStatusModule,
  RbacModule,
  // /admin/resource-subscriptions (CRUD + toggle).
  ResourceSubscriptionModule,
  StorageModule,
  StorageAccessKeyModule,
  // v1-compat SMR summary shims (/api/smr/api/v1/summary/sync + /presummary).
  SmrCompatModule,
  SttCompatModule,
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
  // /admin/webhooks (CRUD + delivery-log reads).
  WebhookModule,
];

// Embedded Prisma Studio is
// production-capable but fail-closed — the module registers only when the
// operator explicitly sets ENABLE_PRISMA_STUDIO=true, and every route is
// additionally guarded by the dedicated `manage:PrismaStudio` permission.
if (shouldEnablePrismaStudio({ NODE_ENV: process.env.NODE_ENV, ENABLE_PRISMA_STUDIO: process.env.ENABLE_PRISMA_STUDIO })) {
  featureModules.push(PrismaStudioModule);
}

@Module({
  imports: [...common, ...featureModules],
  providers: [...interceptors, ...guards, ...filters],
})
export class AppModule {}
