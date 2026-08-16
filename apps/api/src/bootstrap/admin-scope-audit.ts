/**
 * Boot-time audit (TASK-708 Task 5): every `/admin/*` controller this
 * ticket's Task 4 sweep gave a `@RequiredScopes(...)` (or `@ForbidApiKey()`)
 * gate must keep carrying it. Mirrors `auditApiKeyRequiredScopes`'s pattern
 * (`api-key-scope-audit.ts`) — a fixed, explicit, named list read via a
 * plain `Reflector` off the real controller classes, not a gateway-wide
 * `ModulesContainer` sweep — but tracked as ITS OWN list (`ADMIN_SCOPED_CONTROLLERS`)
 * rather than folded into `SDK_DAY1_SCOPED_ROUTES`, per that audit's own
 * docstring: it is deliberately narrow to "the HOPE Node SDK's day-1
 * surface", and this is a DIFFERENT surface (`/admin/*`) closed by a
 * DIFFERENT ticket for a DIFFERENT reason (owner-approved scope narrowing,
 * not an SDK day-1 contract).
 *
 * CLASS-level, not method-level: TASK-708 Task 4 applied one
 * `@RequiredScopes(...)` per controller (coarse-grained by design — see the
 * ticket README §7 for the reasoning), so this audit checks
 * `API_KEY_REQUIRED_SCOPES`/`API_KEY_FORBIDDEN` metadata on the CONTROLLER
 * CLASS, not on individual handler methods.
 */
import { Reflector } from '@nestjs/core';
import { API_KEY_REQUIRED_SCOPES, API_KEY_FORBIDDEN } from '@arcaai/applications';

import { RateLimitAdminController } from '../modules/admin-rate-limit/rate-limit-admin.controller';
import { AdminReconciliationController } from '../modules/admin-usage/admin-reconciliation.controller';
import { AdminUsageController } from '../modules/admin-usage/admin-usage.controller';
import { AgentPromotionController } from '../modules/agent-promotion/agent-promotion.controller';
import { AgentTrajectoryController } from '../modules/agent-trajectory/agent-trajectory.controller';
import { AgenticAdminController } from '../modules/agentic-admin/agentic-admin.controller';
import { AiModelAdminController } from '../modules/ai-model/ai-model-admin.controller';
import { AiModelDiscoveryController } from '../modules/ai-model/ai-model-discovery.controller';
import { ProviderConnectionController } from '../modules/ai-provider-connection/ai-provider-connection.controller';
import { AiProviderConnectionController } from '../modules/ai-provider-connection/ai-provider-connection.controller';
import { AiRuntimeProfileController } from '../modules/ai-runtime-profile/ai-runtime-profile.controller';
import { AiServiceAdminController } from '../modules/ai-service-admin/ai-service-admin.controller';
import { AiTaskDefaultAdminController } from '../modules/ai-task-default/ai-task-default-admin.controller';
import { ApiKeyController } from '../modules/api-key/api-key.controller';
import { AuditLogController } from '../modules/audit-log/audit-log.controller';
import { AdminImpersonationController } from '../modules/auth/admin-impersonation.controller';
import { BillingAdminController } from '../modules/billing/billing-admin.controller';
import { RateCardAdminController } from '../modules/billing/rate-card-admin.controller';
import { ChangelogAdminController } from '../modules/changelog/changelog-admin.controller';
import { ConsultationContextSchemaAdminController } from '../modules/consultation-context-schema/consultation-context-schema.controller';
import { AdminConsultationController } from '../modules/consultation/admin-consultation.controller';
import { DepartmentAgentResyncController } from '../modules/department-agent/department-agent-resync.controller';
import { DepartmentAgentController } from '../modules/department-agent/department-agent.controller';
import { DepartmentController } from '../modules/department/department.controller';
import { DnaWritingStyleAdminController } from '../modules/dna-writing-style/dna-writing-style-admin.controller';
import { EntitlementsAdminController } from '../modules/entitlements/entitlements-admin.controller';
import { GlobalSettingController } from '../modules/global-setting/global-setting.controller';
import { HarnessAdminController } from '../modules/harness-admin/harness-admin.controller';
import { McpAdminController } from '../modules/mcp-admin/mcp-admin.controller';
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
import { WorkflowTestFixtureController } from '../modules/workflow-test-fixture/workflow-test-fixture.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signature is intentionally unconstrained; only class-level metadata is ever read off it
type ControllerClass = new (...args: any[]) => unknown;

interface ScopedController {
  controller: ControllerClass;
  /** Expected @RequiredScopes(...) value, or 'FORBID' for @ForbidApiKey(). */
  expect: string | 'FORBID';
}

/** The `/admin/*` surface TASK-708 Task 4 closed. */
export const ADMIN_SCOPED_CONTROLLERS: ScopedController[] = [
  { controller: RateLimitAdminController, expect: 'admin:rate-limit:manage' },
  { controller: AdminReconciliationController, expect: 'admin:usage:manage' },
  { controller: AdminUsageController, expect: 'admin:usage:manage' },
  { controller: AgentPromotionController, expect: 'admin:agent-promotion:manage' },
  { controller: AgentTrajectoryController, expect: 'admin:agent-trajectory:read' },
  { controller: AgenticAdminController, expect: 'admin:agentic:manage' },
  { controller: AiModelAdminController, expect: 'admin:ai-model:manage' },
  { controller: AiModelDiscoveryController, expect: 'admin:ai-model:manage' },
  { controller: ProviderConnectionController, expect: 'admin:ai-provider:manage' },
  { controller: AiProviderConnectionController, expect: 'admin:ai-provider:manage' },
  { controller: AiRuntimeProfileController, expect: 'admin:ai-runtime-profile:manage' },
  { controller: AiServiceAdminController, expect: 'admin:ai-service:manage' },
  { controller: AiTaskDefaultAdminController, expect: 'admin:ai-task-default:manage' },
  { controller: ApiKeyController, expect: 'admin:apikey:write' },
  { controller: AuditLogController, expect: 'admin:audit:read' },
  { controller: AdminImpersonationController, expect: 'FORBID' },
  { controller: BillingAdminController, expect: 'admin:billing:manage' },
  { controller: RateCardAdminController, expect: 'admin:billing:manage' },
  { controller: ChangelogAdminController, expect: 'admin:changelog:manage' },
  { controller: ConsultationContextSchemaAdminController, expect: 'admin:consultation-context-schema:manage' },
  { controller: AdminConsultationController, expect: 'admin:consultation-admin:manage' },
  { controller: DepartmentAgentResyncController, expect: 'admin:department-agent:manage' },
  { controller: DepartmentAgentController, expect: 'admin:department-agent:manage' },
  { controller: DepartmentController, expect: 'admin:department:manage' },
  { controller: DnaWritingStyleAdminController, expect: 'admin:dna-writing-style:manage' },
  { controller: EntitlementsAdminController, expect: 'admin:entitlement:manage' },
  { controller: GlobalSettingController, expect: 'admin:settings:manage' },
  { controller: HarnessAdminController, expect: 'admin:harness:manage' },
  { controller: McpAdminController, expect: 'admin:mcp-server:manage' },
  { controller: NlpTaskInstructionsAdminController, expect: 'admin:nlp-task-instructions:manage' },
  { controller: NotificationController, expect: 'admin:notification:manage' },
  { controller: PipelinePolicyAdminController, expect: 'admin:pipeline-policy:manage' },
  { controller: AudioPipelineController, expect: 'admin:audio-pipeline:manage' },
  { controller: PlatformMetricsController, expect: 'admin:platform-metrics:read' },
  { controller: PromptManagementController, expect: 'admin:prompt-template:manage' },
  { controller: PrismaStudioStatusController, expect: 'admin:pstudio:manage' },
  { controller: PrismaStudioController, expect: 'admin:pstudio:manage' },
  { controller: QueueAdminController, expect: 'admin:queue:manage' },
  { controller: SchedulerAdminController, expect: 'admin:scheduler:manage' },
  { controller: PoliciesController, expect: 'admin:rbac-policy:write' },
  { controller: RolesController, expect: 'admin:role:write' },
  { controller: ResourceSubscriptionController, expect: 'admin:resource-subscription:manage' },
  { controller: ServiceReleaseAdminController, expect: 'admin:service-release:manage' },
  { controller: SettingsCatalogController, expect: 'admin:settings:manage' },
  { controller: SettingsRegistryWriteController, expect: 'admin:settings:manage' },
  { controller: StorageAccessKeyController, expect: 'admin:storage-key:manage' },
  { controller: AdminTranscriptionJobController, expect: 'admin:transcription-job:read' },
  { controller: TenantAllowedOriginController, expect: 'admin:allowed-origin:manage' },
  { controller: TenantBucketController, expect: 'admin:tenant-storage:manage' },
  { controller: TenantFrontendConfigAdminController, expect: 'admin:tenant-frontend-config:manage' },
  { controller: TenantIdpConfigAdminController, expect: 'admin:tenant-idp-config:manage' },
  { controller: TenantStorageConfigAdminController, expect: 'admin:tenant-storage:manage' },
  { controller: TenantSttConfigAdminController, expect: 'admin:tenant-stt-config:manage' },
  { controller: TenantTtsConfigAdminController, expect: 'admin:tenant-tts-config:manage' },
  { controller: TenantPipelineResyncController, expect: 'admin:tenant:write' },
  { controller: TenantProvisionController, expect: 'admin:tenant:write' },
  { controller: TenantController, expect: 'admin:tenant:write' },
  { controller: UserDepartmentsController, expect: 'admin:user:write' },
  { controller: UserController, expect: 'admin:user:write' },
  { controller: WebhookController, expect: 'webhook:event:write' },
  { controller: WorkflowDefinitionController, expect: 'admin:workflow-definition:manage' },
  { controller: WorkflowNodeController, expect: 'admin:workflow-node:read' },
  { controller: WorkflowRunController, expect: 'admin:workflow-run:read' },
  { controller: WorkflowTestFixtureController, expect: 'admin:workflow-test-fixture:manage' },
];

export function auditAdminScopedControllers(controllers: ScopedController[] = ADMIN_SCOPED_CONTROLLERS): void {
  const reflector = new Reflector();
  const offenders: string[] = [];

  for (const { controller, expect } of controllers) {
    if (expect === 'FORBID') {
      const forbidden = reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [controller]);
      if (forbidden !== true) {
        offenders.push(`${controller.name} is on the TASK-708 admin bucket-(c) list but carries no @ForbidApiKey() metadata.`);
      }
      continue;
    }

    const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [controller]);
    if (!Array.isArray(scopes) || scopes.length === 0) {
      offenders.push(
        `${controller.name} is on the TASK-708 /admin/* scope-closure list but carries no @RequiredScopes(...) metadata. ` + `Expected '${expect}'.`,
      );
    } else if (!scopes.includes(expect)) {
      offenders.push(`${controller.name} carries @RequiredScopes(${scopes.join(', ')}) but TASK-708 expected it to include '${expect}'.`);
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`TASK-708: refused to start — ${offenders.length} /admin/* controller(s) lost their API-key scope gate:\n${list}`);
  }
}
