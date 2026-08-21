/**
 * TASK-773 — controller -> admin-scope evidence fixture.
 *
 * This is EVIDENCE, not configuration. It is a mechanical transcription of
 * every class-level `@RequiredScopes('admin:<area>')` decorator that commit
 * `276f96a32` ("feat(TASK-757): the admin plane is JWT-only (policy A2)")
 * removed in favor of `@ForbidApiKey()`, extracted by parsing that commit's
 * diff of `apps/api/src/modules` (see `git show 276f96a32 -- apps/api/src/modules`).
 *
 * TASK-773 puts a service-account scope back on each of these controllers —
 * `@RequiredSvcScopes(toServiceAccountScope(adminScope))`, i.e.
 * `svc:admin:<area>` — and a boot audit reads this fixture to prove every row
 * actually landed with the right scope. A wrong or missing row here silently
 * mis-scopes (or leaves unreachable) a real administration route, so it is
 * transcribed 1:1 from the commit rather than hand-typed from memory.
 *
 * The `svc:` form is deliberately NOT written here. It is DERIVED at use time
 * via `toServiceAccountScope` (`packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts`)
 * — the one place a `svc:` string is constructed — so this fixture cannot
 * itself drift from that renamespacing rule.
 *
 * ─── Why this is 64 rows, not 65 or 70 ──────────────────────────────────────
 *
 * The commit message says "All 65 admin controllers swept" and "70
 * admin-prefixed controllers" total. Reconciling those numbers against this
 * fixture's 64 rows (verified by `task-773-admin-scope-map.test.ts`):
 *
 *   - 65 classes had a class-level `@RequiredScopes(...)` removed. 64 of them
 *     used the `admin:<area>` grammar this fixture records (one file,
 *     `ai-provider-connection.controller.ts`, carries TWO such classes —
 *     `ProviderConnectionController` and `AiProviderConnectionController` —
 *     both gated by `admin:ai-provider:manage`, so 64 rows span 63 files).
 *   - The 65th, `WebhookController` (`admin/webhooks`), had
 *     `@RequiredScopes('webhook:event:write')` removed — a `webhook:*`
 *     scope, not `admin:*`. It is deliberately EXCLUDED from this fixture:
 *     the task this fixture serves is specifically the `admin:<area>` ->
 *     `svc:admin:<area>` renamespacing, and `webhook:event:write` does not
 *     match that grammar (confirmed live in
 *     `packages/applications/src/services/apiKey/apikey-scopes.registry.ts`,
 *     where it is registered under category `'Webhook'`, not `'Admin'`).
 *   - The remaining 5 of the "70 admin-prefixed controllers" were NEVER
 *     class-level-`@RequiredScopes`-gated, so they have no `admin:*` scope
 *     string for this fixture to record: `AdminImpersonationController`
 *     (`admin/users`), `MonitoringController` (`admin/monitoring`),
 *     `AdminHealthServicesController` (`admin/health/services`),
 *     `ConsentGrantController` (`admin/consent-grants`) and
 *     `ServiceAccountController` (`admin/service-accounts` — which also
 *     carries `@ForbidServiceAccount()`, a deliberate self-exclusion so a
 *     service account can never administer service accounts). All five are
 *     gated by ability decorators (`@CanAny`/`@CanManage`) instead, and are
 *     exactly the four the OLD hand-rolled boot-audit list never held
 *     (per the 276f96a32 commit message) plus `AdminImpersonationController`.
 *     65 + 5 = 70, matching the commit message exactly.
 */
export interface AdminScopeMapRow {
  /** Repo-relative path of the controller source file. */
  file: string;
  /** Exported controller class name. */
  controllerClass: string;
  /** The exact `admin:*` scope removed by TASK-757 (276f96a32). */
  adminScope: string;
  /**
   * Set when the controller's MODULE registers it conditionally, so its absence
   * from the running module graph is a supported configuration rather than a
   * missing sweep.
   *
   * Boot audit H must not treat such a row as an offender when the class is
   * absent — it still validates the declaration whenever the class IS
   * registered, so a mis-scoped route cannot hide behind the flag. Without this,
   * H refuses to start on every host running the default configuration, which is
   * a boot failure introduced by the audit rather than caught by it.
   */
  conditionallyRegistered?: {
    /** The env var (or condition) that governs registration. */
    condition: string;
    /** Why it is off by default. */
    reason: string;
  };
}

export const TASK_773_ADMIN_SCOPE_MAP: readonly AdminScopeMapRow[] = [
  {
    file: 'apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts',
    controllerClass: 'RateLimitAdminController',
    adminScope: 'admin:rate-limit:manage',
  },
  {
    file: 'apps/api/src/modules/admin-usage/admin-reconciliation.controller.ts',
    controllerClass: 'AdminReconciliationController',
    adminScope: 'admin:usage:manage',
  },
  { file: 'apps/api/src/modules/admin-usage/admin-usage.controller.ts', controllerClass: 'AdminUsageController', adminScope: 'admin:usage:manage' },
  {
    file: 'apps/api/src/modules/agent-promotion/agent-promotion.controller.ts',
    controllerClass: 'AgentPromotionController',
    adminScope: 'admin:agent-promotion:manage',
  },
  {
    file: 'apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts',
    controllerClass: 'AgentTrajectoryController',
    adminScope: 'admin:agent-trajectory:read',
  },
  {
    file: 'apps/api/src/modules/agentic-admin/agentic-admin.controller.ts',
    controllerClass: 'AgenticAdminController',
    adminScope: 'admin:agentic:manage',
  },
  {
    file: 'apps/api/src/modules/ai-model/ai-model-admin.controller.ts',
    controllerClass: 'AiModelAdminController',
    adminScope: 'admin:ai-model:manage',
  },
  {
    file: 'apps/api/src/modules/ai-model/ai-model-discovery.controller.ts',
    controllerClass: 'AiModelDiscoveryController',
    adminScope: 'admin:ai-model:manage',
  },
  {
    file: 'apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts',
    controllerClass: 'ProviderConnectionController',
    adminScope: 'admin:ai-provider:manage',
  },
  {
    file: 'apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts',
    controllerClass: 'AiProviderConnectionController',
    adminScope: 'admin:ai-provider:manage',
  },
  {
    file: 'apps/api/src/modules/ai-runtime-profile/ai-runtime-profile.controller.ts',
    controllerClass: 'AiRuntimeProfileController',
    adminScope: 'admin:ai-runtime-profile:manage',
  },
  {
    file: 'apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts',
    controllerClass: 'AiServiceAdminController',
    adminScope: 'admin:ai-service:manage',
  },
  {
    file: 'apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts',
    controllerClass: 'AiTaskDefaultAdminController',
    adminScope: 'admin:ai-task-default:manage',
  },
  { file: 'apps/api/src/modules/api-key/api-key.controller.ts', controllerClass: 'ApiKeyController', adminScope: 'admin:apikey:write' },
  { file: 'apps/api/src/modules/audit-log/audit-log.controller.ts', controllerClass: 'AuditLogController', adminScope: 'admin:audit:read' },
  { file: 'apps/api/src/modules/billing/billing-admin.controller.ts', controllerClass: 'BillingAdminController', adminScope: 'admin:billing:manage' },
  {
    file: 'apps/api/src/modules/billing/rate-card-admin.controller.ts',
    controllerClass: 'RateCardAdminController',
    adminScope: 'admin:billing:manage',
  },
  {
    file: 'apps/api/src/modules/changelog/changelog-admin.controller.ts',
    controllerClass: 'ChangelogAdminController',
    adminScope: 'admin:changelog:manage',
  },
  {
    file: 'apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts',
    controllerClass: 'ConsultationContextSchemaAdminController',
    adminScope: 'admin:consultation-context-schema:manage',
  },
  {
    file: 'apps/api/src/modules/consultation/admin-consultation.controller.ts',
    controllerClass: 'AdminConsultationController',
    adminScope: 'admin:consultation-admin:manage',
  },
  {
    file: 'apps/api/src/modules/department-agent/department-agent-resync.controller.ts',
    controllerClass: 'DepartmentAgentResyncController',
    adminScope: 'admin:department-agent:manage',
  },
  {
    file: 'apps/api/src/modules/department-agent/department-agent.controller.ts',
    controllerClass: 'DepartmentAgentController',
    adminScope: 'admin:department-agent:manage',
  },
  {
    file: 'apps/api/src/modules/department/department.controller.ts',
    controllerClass: 'DepartmentController',
    adminScope: 'admin:department:manage',
  },
  {
    file: 'apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts',
    controllerClass: 'DnaWritingStyleAdminController',
    adminScope: 'admin:dna-writing-style:manage',
  },
  {
    file: 'apps/api/src/modules/entitlements/entitlements-admin.controller.ts',
    controllerClass: 'EntitlementsAdminController',
    adminScope: 'admin:entitlement:manage',
  },
  {
    file: 'apps/api/src/modules/global-setting/global-setting.controller.ts',
    controllerClass: 'GlobalSettingController',
    adminScope: 'admin:settings:manage',
  },
  {
    file: 'apps/api/src/modules/harness-admin/harness-admin.controller.ts',
    controllerClass: 'HarnessAdminController',
    adminScope: 'admin:harness:manage',
  },
  { file: 'apps/api/src/modules/knowledge/knowledge.controller.ts', controllerClass: 'KnowledgeController', adminScope: 'admin:knowledge:manage' },
  { file: 'apps/api/src/modules/mcp-admin/mcp-admin.controller.ts', controllerClass: 'McpAdminController', adminScope: 'admin:mcp-server:manage' },
  {
    file: 'apps/api/src/modules/nlp-task-instructions/nlp-task-instructions-admin.controller.ts',
    controllerClass: 'NlpTaskInstructionsAdminController',
    adminScope: 'admin:nlp-task-instructions:manage',
  },
  {
    file: 'apps/api/src/modules/notification/notification.controller.ts',
    controllerClass: 'NotificationController',
    adminScope: 'admin:notification:manage',
  },
  {
    file: 'apps/api/src/modules/pipeline-policy-admin/pipeline-policy-admin.controller.ts',
    controllerClass: 'PipelinePolicyAdminController',
    adminScope: 'admin:pipeline-policy:manage',
  },
  {
    file: 'apps/api/src/modules/pipeline/audio-pipeline.controller.ts',
    controllerClass: 'AudioPipelineController',
    adminScope: 'admin:audio-pipeline:manage',
  },
  {
    file: 'apps/api/src/modules/platform-metrics/platform-metrics.controller.ts',
    controllerClass: 'PlatformMetricsController',
    adminScope: 'admin:platform-metrics:read',
  },
  {
    file: 'apps/api/src/modules/prompt-management/prompt-management.controller.ts',
    controllerClass: 'PromptManagementController',
    adminScope: 'admin:prompt-template:manage',
  },
  {
    file: 'apps/api/src/modules/pstudio/pstudio-status.controller.ts',
    controllerClass: 'PrismaStudioStatusController',
    adminScope: 'admin:pstudio:manage',
  },
  {
    file: 'apps/api/src/modules/pstudio/pstudio.controller.ts',
    controllerClass: 'PrismaStudioController',
    adminScope: 'admin:pstudio:manage',
    // `PrismaStudioModule` lists this controller unconditionally, but the module
    // itself is only imported when `shouldEnablePrismaStudio(env)` is true
    // (`pstudio.module.ts:14`). The default is OFF, so on an ordinary host —
    // production included — this class is registered by no module at all.
    conditionallyRegistered: {
      condition: 'ENABLE_PRISMA_STUDIO=true',
      reason: 'Prisma Studio is fail-closed: it registers only when an operator explicitly opts in, so it can never surface on a misconfigured host.',
    },
  },
  { file: 'apps/api/src/modules/queue-admin/queue-admin.controller.ts', controllerClass: 'QueueAdminController', adminScope: 'admin:queue:manage' },
  {
    file: 'apps/api/src/modules/queue-admin/scheduler-admin.controller.ts',
    controllerClass: 'SchedulerAdminController',
    adminScope: 'admin:scheduler:manage',
  },
  { file: 'apps/api/src/modules/rbac/policies.controller.ts', controllerClass: 'PoliciesController', adminScope: 'admin:rbac-policy:write' },
  { file: 'apps/api/src/modules/rbac/roles.controller.ts', controllerClass: 'RolesController', adminScope: 'admin:role:write' },
  {
    file: 'apps/api/src/modules/resource-subscription/resource-subscription.controller.ts',
    controllerClass: 'ResourceSubscriptionController',
    adminScope: 'admin:resource-subscription:manage',
  },
  {
    file: 'apps/api/src/modules/service-release/service-release-admin.controller.ts',
    controllerClass: 'ServiceReleaseAdminController',
    adminScope: 'admin:service-release:manage',
  },
  {
    file: 'apps/api/src/modules/settings-catalog/settings-catalog.controller.ts',
    controllerClass: 'SettingsCatalogController',
    adminScope: 'admin:settings:manage',
  },
  {
    file: 'apps/api/src/modules/settings-catalog/settings-registry-write.controller.ts',
    controllerClass: 'SettingsRegistryWriteController',
    adminScope: 'admin:settings:manage',
  },
  {
    file: 'apps/api/src/modules/storage-access-key/storage-access-key.controller.ts',
    controllerClass: 'StorageAccessKeyController',
    adminScope: 'admin:storage-key:manage',
  },
  {
    file: 'apps/api/src/modules/streaming/admin-transcription-job.controller.ts',
    controllerClass: 'AdminTranscriptionJobController',
    adminScope: 'admin:transcription-job:read',
  },
  {
    file: 'apps/api/src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts',
    controllerClass: 'TenantAllowedOriginController',
    adminScope: 'admin:allowed-origin:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts',
    controllerClass: 'TenantBucketController',
    adminScope: 'admin:tenant-storage:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts',
    controllerClass: 'TenantFrontendConfigAdminController',
    adminScope: 'admin:tenant-frontend-config:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-idp-config/tenant-idp-config-admin.controller.ts',
    controllerClass: 'TenantIdpConfigAdminController',
    adminScope: 'admin:tenant-idp-config:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-storage-config/tenant-storage-config-admin.controller.ts',
    controllerClass: 'TenantStorageConfigAdminController',
    adminScope: 'admin:tenant-storage:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-stt-config/tenant-stt-config-admin.controller.ts',
    controllerClass: 'TenantSttConfigAdminController',
    adminScope: 'admin:tenant-stt-config:manage',
  },
  {
    file: 'apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts',
    controllerClass: 'TenantTtsConfigAdminController',
    adminScope: 'admin:tenant-tts-config:manage',
  },
  {
    file: 'apps/api/src/modules/tenant/tenant-pipeline-resync.controller.ts',
    controllerClass: 'TenantPipelineResyncController',
    adminScope: 'admin:tenant:write',
  },
  {
    file: 'apps/api/src/modules/tenant/tenant-provision.controller.ts',
    controllerClass: 'TenantProvisionController',
    adminScope: 'admin:tenant:write',
  },
  { file: 'apps/api/src/modules/tenant/tenant.controller.ts', controllerClass: 'TenantController', adminScope: 'admin:tenant:write' },
  {
    file: 'apps/api/src/modules/user/controllers/user-departments.controller.ts',
    controllerClass: 'UserDepartmentsController',
    adminScope: 'admin:user:write',
  },
  { file: 'apps/api/src/modules/user/user.controller.ts', controllerClass: 'UserController', adminScope: 'admin:user:write' },
  {
    file: 'apps/api/src/modules/workflow-definition/workflow-definition.controller.ts',
    controllerClass: 'WorkflowDefinitionController',
    adminScope: 'admin:workflow-definition:manage',
  },
  {
    file: 'apps/api/src/modules/workflow-node/workflow-node.controller.ts',
    controllerClass: 'WorkflowNodeController',
    adminScope: 'admin:workflow-node:read',
  },
  {
    file: 'apps/api/src/modules/workflow-run/workflow-run.controller.ts',
    controllerClass: 'WorkflowRunController',
    adminScope: 'admin:workflow-run:read',
  },
  {
    file: 'apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts',
    controllerClass: 'WorkflowSandboxRunController',
    adminScope: 'admin:workflow-definition:manage',
  },
  {
    file: 'apps/api/src/modules/workflow-test-fixture/workflow-test-fixture.controller.ts',
    controllerClass: 'WorkflowTestFixtureController',
    adminScope: 'admin:workflow-test-fixture:manage',
  },
];
