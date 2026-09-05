/**
 * Boot-time audit for policy **A2**: `/api/v1/admin/*` is a
 * **JWT-only** plane. API keys are prohibited there, so an `admin/`-prefixed
 * route must carry `@ForbidApiKey()` and must never declare `@RequiredScopes`.
 *
 * This file previously enforced the OPPOSITE invariant (each
 * named admin controller keeps its named `@RequiredScopes` value). A2 inverts
 * it. The 56 `admin:*` scope strings were NOT deleted — they are reserved in
 * `apikey-scopes.registry.ts` (refused at grant time, dropped from the
 * advertised catalog) and remain the vocabulary service-account
 * plane reuses. Deletion would not have stopped regrowth anyway:
 * `@RequiredScopes` takes a RAW STRING and `enforceApiKeyScopes` never consults
 * the registry, so only enforcement stops a new admin controller from inventing
 * `admin:new-thing:manage`. That enforcement is `auditAdminControllersDeclareNoApiKeyScopes`
 * below.
 *
 * ─── Two audits, deliberately different in kind ────────────────────────────
 *
 * 1. `auditAdminControllersDeclareNoApiKeyScopes(app)` — **the derived sweep,
 *    and the gate that actually holds the line.** Walks `ModulesContainer` and
 *    reads resolved metadata through the app's own `Reflector`, so it sees
 *    exactly what `UnifiedAuthGuard` sees — including class-level decorators,
 *    which Nest does NOT copy onto handlers. A brand-new admin controller is
 *    caught on the day it is written, with no list to update.
 *
 * 2. `auditAdminScopedControllers()` — **the named list**, collapsed so every
 *    entry expects `'FORBID'`. It catches a different failure the sweep
 *    structurally cannot: a controller that stops being registered in any
 *    module disappears from the sweep entirely, but its absence from a
 *    registered module is still a change worth noticing. Kept for that reason,
 *    not as the primary gate — the hand-transcribed version of this list
 *    silently policed only 63 of 65 admin controllers, because
 *    `KnowledgeController` and `WorkflowSandboxRunController` were never
 *    transcribed into it. That drift is precisely the argument for (1).
 *
 * CLASS-level, not method-level, for the named list: applied
 * one decorator per controller and A2 replaces it in place, so the named audit
 * reads metadata off the CONTROLLER CLASS. The derived sweep reads BOTH levels.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_REQUIRED_SCOPES, API_KEY_FORBIDDEN, SKIP_AUTH_KEY } from '@arcaai/applications';

// Side-effect import — patches @Public() onto third-party controllers we cannot
// decorate at the source. Must run before the walk, exactly as
// `admin-route-permission-audit.ts` requires.
import './third-party-public-routes';

import { RateLimitAdminController } from '../modules/admin-rate-limit/rate-limit-admin.controller';
import { AdminUsageController } from '../modules/admin-usage/admin-usage.controller';
import { AgentPromotionController } from '../modules/agent-promotion/agent-promotion.controller';
import { AgentTrajectoryController } from '../modules/agent-trajectory/agent-trajectory.controller';
import { AgenticAdminController } from '../modules/agentic-admin/agentic-admin.controller';
import { AiModelAdminController } from '../modules/ai-model/ai-model-admin.controller';
import { AiModelDiscoveryController } from '../modules/ai-model/ai-model-discovery.controller';
import { ProviderConnectionController } from '../modules/ai-provider-connection/ai-provider-connection.controller';
import { AiServiceAdminController } from '../modules/ai-service-admin/ai-service-admin.controller';
import { ApiKeyController } from '../modules/api-key/api-key.controller';
import { AuditLogController } from '../modules/audit-log/audit-log.controller';
import { AdminImpersonationController } from '../modules/auth/admin-impersonation.controller';
import { BillingAdminController } from '../modules/billing/billing-admin.controller';
import { RateCardAdminController } from '../modules/billing/rate-card-admin.controller';
import { ChangelogAdminController } from '../modules/changelog/changelog-admin.controller';
import { ConsultationContextSchemaAdminController } from '../modules/consultation-context-schema/consultation-context-schema.controller';
import { AdminConsultationController } from '../modules/consultation/admin-consultation.controller';
import { ConsentGrantController } from '../modules/consent/consent.controller';
import { DepartmentController } from '../modules/department/department.controller';
import { DnaWritingStyleAdminController } from '../modules/dna-writing-style/dna-writing-style-admin.controller';
import { EntitlementsAdminController } from '../modules/entitlements/entitlements-admin.controller';
import { GlobalSettingController } from '../modules/global-setting/global-setting.controller';
import { HarnessAdminController } from '../modules/harness-admin/harness-admin.controller';
import { KnowledgeController } from '../modules/knowledge/knowledge.controller';
import { AdminHealthServicesController } from '../modules/health/admin-health-services.controller';
import { McpAdminController } from '../modules/mcp-admin/mcp-admin.controller';
import { MonitoringController } from '../modules/monitoring/monitoring.controller';
import { NlpTaskInstructionsAdminController } from '../modules/nlp-task-instructions/nlp-task-instructions-admin.controller';
import { NotificationController } from '../modules/notification/notification.controller';
import { PipelinePolicyAdminController } from '../modules/pipeline-policy-admin/pipeline-policy-admin.controller';
import { AudioPipelineController } from '../modules/pipeline/audio-pipeline.controller';
import { PlatformMetricsController } from '../modules/platform-metrics/platform-metrics.controller';
import { PromptManagementController } from '../modules/prompt-management/prompt-management.controller';
import { PrismaStudioStatusController } from '../modules/pstudio/pstudio-status.controller';
import { PrismaStudioController } from '../modules/pstudio/pstudio.controller';
import { QueueAdminController } from '../modules/queue-admin/queue-admin.controller';
import { SchedulerAdminController } from '../modules/queue-admin/scheduler-admin.controller';
import { PoliciesController } from '../modules/rbac/policies.controller';
import { RolesController } from '../modules/rbac/roles.controller';
import { ResourceSubscriptionController } from '../modules/resource-subscription/resource-subscription.controller';
import { ServiceReleaseAdminController } from '../modules/service-release/service-release-admin.controller';
import { SettingsCatalogController } from '../modules/settings-catalog/settings-catalog.controller';
import { SettingsRegistryWriteController } from '../modules/settings-catalog/settings-registry-write.controller';
import { StorageAccessKeyController } from '../modules/storage-access-key/storage-access-key.controller';
import { AdminTranscriptionJobController } from '../modules/streaming/admin-transcription-job.controller';
import { TenantAllowedOriginController } from '../modules/tenant-allowed-origin/tenant-allowed-origin.controller';
import { TenantBucketController } from '../modules/tenant-bucket/tenant-bucket.controller';
import { TenantFrontendConfigAdminController } from '../modules/tenant-frontend-config/tenant-frontend-config-admin.controller';
import { TenantIdpConfigAdminController } from '../modules/tenant-idp-config/tenant-idp-config-admin.controller';
import { TenantStorageConfigAdminController } from '../modules/tenant-storage-config/tenant-storage-config-admin.controller';
import { TenantSttConfigAdminController } from '../modules/tenant-stt-config/tenant-stt-config-admin.controller';
import { TenantTtsConfigAdminController } from '../modules/tenant-tts-config/tenant-tts-config-admin.controller';
import { TenantPipelineResyncController } from '../modules/tenant/tenant-pipeline-resync.controller';
import { TenantProvisionController } from '../modules/tenant/tenant-provision.controller';
import { TenantController } from '../modules/tenant/tenant.controller';
import { UserDepartmentsController } from '../modules/user/controllers/user-departments.controller';
import { UserController } from '../modules/user/user.controller';
import { WebhookController } from '../modules/webhook/webhook.controller';
import { WorkflowDefinitionController } from '../modules/workflow-definition/workflow-definition.controller';
import { WorkflowNodeController } from '../modules/workflow-node/workflow-node.controller';
import { WorkflowRunController } from '../modules/workflow-run/workflow-run.controller';
import { ServiceAccountController } from '../modules/service-account/service-account.controller';
import { WorkflowSandboxRunController } from '../modules/workflow-sandbox-run/workflow-sandbox-run.controller';
import { WorkflowTestFixtureController } from '../modules/workflow-test-fixture/workflow-test-fixture.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signature is intentionally unconstrained; only class-level metadata is ever read off it
type ControllerClass = new (...args: any[]) => unknown;

interface ScopedController {
  controller: ControllerClass;
  /**
   * Under A2 the only legal value is `'FORBID'` (`@ForbidApiKey()`). The union
   * is kept so the audit can still describe — and reject — a controller that
   * has REGROWN a `@RequiredScopes` declaration, rather than silently ignoring
   * one.
   */
  expect: 'FORBID';
}

/** The `/admin/*` surface closed. */
/**
 * Every `admin/`-prefixed controller registered in the gateway — **70** of
 * them, all expecting `'FORBID'`.
 *
 * Under A2 there is no per-controller scope VALUE left to pin, so the list's
 * remaining job is to notice a controller that vanishes from the module graph
 * (which the derived sweep cannot see, because it only walks what is
 * registered). It also closes the transcription gap in the original:
 * `KnowledgeController`, `WorkflowSandboxRunController`, `ConsentGrantController`
 * and `ServiceAccountController` were all absent from it.
 *
 * `auditAdminControllersDeclareNoApiKeyScopes` is what stops REGROWTH; this
 * list cannot, and must not be mistaken for the gate.
 */
export const ADMIN_SCOPED_CONTROLLERS: ScopedController[] = [
  { controller: AdminConsultationController, expect: 'FORBID' },
  { controller: AdminHealthServicesController, expect: 'FORBID' },
  { controller: AdminImpersonationController, expect: 'FORBID' },
  { controller: AdminTranscriptionJobController, expect: 'FORBID' },
  { controller: AdminUsageController, expect: 'FORBID' },
  { controller: AgentPromotionController, expect: 'FORBID' },
  { controller: AgentTrajectoryController, expect: 'FORBID' },
  { controller: AgenticAdminController, expect: 'FORBID' },
  { controller: AiModelAdminController, expect: 'FORBID' },
  { controller: AiModelDiscoveryController, expect: 'FORBID' },
  { controller: AiServiceAdminController, expect: 'FORBID' },
  { controller: ApiKeyController, expect: 'FORBID' },
  { controller: AudioPipelineController, expect: 'FORBID' },
  { controller: AuditLogController, expect: 'FORBID' },
  { controller: BillingAdminController, expect: 'FORBID' },
  { controller: ChangelogAdminController, expect: 'FORBID' },
  { controller: ConsentGrantController, expect: 'FORBID' },
  { controller: ConsultationContextSchemaAdminController, expect: 'FORBID' },
  { controller: DepartmentController, expect: 'FORBID' },
  { controller: DnaWritingStyleAdminController, expect: 'FORBID' },
  { controller: EntitlementsAdminController, expect: 'FORBID' },
  { controller: GlobalSettingController, expect: 'FORBID' },
  { controller: HarnessAdminController, expect: 'FORBID' },
  { controller: KnowledgeController, expect: 'FORBID' },
  { controller: McpAdminController, expect: 'FORBID' },
  { controller: MonitoringController, expect: 'FORBID' },
  { controller: NlpTaskInstructionsAdminController, expect: 'FORBID' },
  { controller: NotificationController, expect: 'FORBID' },
  { controller: PipelinePolicyAdminController, expect: 'FORBID' },
  { controller: PlatformMetricsController, expect: 'FORBID' },
  { controller: PoliciesController, expect: 'FORBID' },
  { controller: PrismaStudioController, expect: 'FORBID' },
  { controller: PrismaStudioStatusController, expect: 'FORBID' },
  { controller: PromptManagementController, expect: 'FORBID' },
  { controller: ProviderConnectionController, expect: 'FORBID' },
  { controller: QueueAdminController, expect: 'FORBID' },
  { controller: RateCardAdminController, expect: 'FORBID' },
  { controller: RateLimitAdminController, expect: 'FORBID' },
  { controller: ResourceSubscriptionController, expect: 'FORBID' },
  { controller: RolesController, expect: 'FORBID' },
  { controller: SchedulerAdminController, expect: 'FORBID' },
  { controller: ServiceAccountController, expect: 'FORBID' },
  { controller: ServiceReleaseAdminController, expect: 'FORBID' },
  { controller: SettingsCatalogController, expect: 'FORBID' },
  { controller: SettingsRegistryWriteController, expect: 'FORBID' },
  { controller: StorageAccessKeyController, expect: 'FORBID' },
  { controller: TenantAllowedOriginController, expect: 'FORBID' },
  { controller: TenantBucketController, expect: 'FORBID' },
  { controller: TenantController, expect: 'FORBID' },
  { controller: TenantFrontendConfigAdminController, expect: 'FORBID' },
  { controller: TenantIdpConfigAdminController, expect: 'FORBID' },
  { controller: TenantPipelineResyncController, expect: 'FORBID' },
  { controller: TenantProvisionController, expect: 'FORBID' },
  { controller: TenantStorageConfigAdminController, expect: 'FORBID' },
  { controller: TenantSttConfigAdminController, expect: 'FORBID' },
  { controller: TenantTtsConfigAdminController, expect: 'FORBID' },
  { controller: UserController, expect: 'FORBID' },
  { controller: UserDepartmentsController, expect: 'FORBID' },
  { controller: WebhookController, expect: 'FORBID' },
  { controller: WorkflowDefinitionController, expect: 'FORBID' },
  { controller: WorkflowNodeController, expect: 'FORBID' },
  { controller: WorkflowRunController, expect: 'FORBID' },
  { controller: WorkflowSandboxRunController, expect: 'FORBID' },
  { controller: WorkflowTestFixtureController, expect: 'FORBID' },
];

export function auditAdminScopedControllers(controllers: ScopedController[] = ADMIN_SCOPED_CONTROLLERS): void {
  const reflector = new Reflector();
  const offenders: string[] = [];

  for (const { controller } of controllers) {
    const forbidden = reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [controller]);
    if (forbidden !== true) {
      offenders.push(
        `${controller.name} is an /admin/* controller but carries no @ForbidApiKey() metadata. ` + `Policy A2 : the admin plane is JWT-only.`,
      );
    }

    // A controller could carry BOTH — `@ForbidApiKey()` wins at runtime, but a
    // stray `@RequiredScopes` is dead metadata that reads as "API keys reach
    // this", so it is an authoring error either way.
    const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [controller]);
    if (Array.isArray(scopes) && scopes.length > 0) {
      offenders.push(
        `${controller.name} is an /admin/* controller and still declares @RequiredScopes(${scopes.join(', ')}). ` +
          `Policy A2  prohibits API keys on the admin plane; remove the decorator.`,
      );
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} /admin/* controller(s) violate policy A2 (JWT-only):\n${list}`);
  }
}

/** `admin/...`, tolerating an explicitly spelled-out global prefix. */
const ADMIN_ROUTE_RE = /^\/(?:api\/v\d+\/)?admin(\/|$)/;

/**
 * Policy **A2**, derived — the gate that survives new controllers.
 *
 * Walks every registered route and fails the boot when an `admin/`-prefixed
 * route resolves a non-empty `API_KEY_REQUIRED_SCOPES`. Reads through the app's
 * own `Reflector` with `getAllAndOverride([methodRef, ControllerClass])`, so it
 * sees exactly what `UnifiedAuthGuard` sees at request time — including
 * class-level decorators, which Nest does NOT copy onto route handlers.
 *
 * `@Public()` routes are skipped: authentication never runs on them, so there
 * is no credential class to have an opinion about (they are covered by
 * `admin-route-permission-audit.ts` instead).
 *
 * This does NOT check that a declaration is PRESENT — that is
 * `auditEveryApiKeyReachableRouteDeclaresScopes`'s job and stays
 * there. The two compose: says "declare something", A2 says "on the
 * admin plane the only legal something is `@ForbidApiKey()`".
 */
export function auditAdminControllersDeclareNoApiKeyScopes(app: INestApplicationContext): void {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const offenders: string[] = [];

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readControllerPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        const fullPath = joinPath(controllerPath, readMethodPath(methodRef));
        if (!ADMIN_ROUTE_RE.test(fullPath)) continue;

        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        const legacyPublic = reflector.getAllAndOverride<boolean>('isPublic', [methodRef, ControllerClass]);
        if (skipAuth === true || legacyPublic === true) continue;

        const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [methodRef, ControllerClass]);
        if (!Array.isArray(scopes) || scopes.length === 0) continue;

        offenders.push(
          `Route ${fullPath} on ${ControllerClass.name}.${methodName} declares @RequiredScopes(${scopes.join(', ')}) ` +
            `on the admin plane. Policy A2 : /api/v1/admin/* is JWT-only — API keys are prohibited there, ` +
            `and every admin:* scope is inert at runtime because @ForbidApiKey() is checked before the scope check. ` +
            `Replace the decorator with @ForbidApiKey(). If this surface genuinely needs a machine credential, that ` +
            `is  service-account plane (@RequiredSvcScopes), not a tenant API key.`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} admin-plane route(s) declare @RequiredScopes:\n${list}`);
  }
}

function readControllerPath(controllerClass: new (...args: unknown[]) => unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, controllerClass);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function readMethodPath(methodRef: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, methodRef as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function joinPath(controllerPath: string, methodPath: string): string {
  const normalize = (segment: string): string => {
    if (!segment) return '';
    return segment.startsWith('/') ? segment : `/${segment}`;
  };
  const a = normalize(controllerPath).replace(/\/+$/, '');
  const b = normalize(methodPath).replace(/\/+$/, '');
  const joined = `${a}${b}` || '/';
  return joined.startsWith('/') ? joined : `/${joined}`;
}
