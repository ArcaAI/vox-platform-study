# apps/api controllers — grouped views

Companion to [api-controller-inventory.md](./api-controller-inventory.md). Same verified data (105 HTTP controllers + 3 WebSocket gateways = 108 rows; 605 HTTP/SSE + 15 gateway handlers — TASK-759 split `AdminHealthServicesController` out of `ApiHealthController`, moving 2 handlers between classes without changing the total), regrouped. Every row appears exactly once per view.

**Access scope** merges the inventory's two authorization columns: the API-key scope that reaches the route, and the CASL ability checked for a bearer JWT. Where a decorator understates the real gate (`AUTH-NOTE` cases — super-admin-only, owner-scoped, SYSTEM-vs-tenant), the Notes column says so; read the service before widening one.

---

## View A — by core business capability

The three named capabilities, plus TTS (adjacent), the shared AI runtime all three resolve through, and the platform residual.

### STT — Standalone speech-to-text

Audio in, transcript out — batch jobs, live streaming, ASR pipeline config, speaker/voice profiles. Two legacy v1 compat surfaces (`api/stt` HTTP + `/stt` WS) sit outside the `api/v1` prefix.

*10 controllers · 76 handlers*


| Controller                          | Prefix                                  | APIs | Auth model    | Access scope                                                                                             | Notes                                                                               |
| ----------------------------------- | --------------------------------------- | ---- | ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **TranscriptionJobController**      | `api/v1/audio/transcription-jobs`       | 20   | JWT + API key | scope `stt:transcription:write` jwt: @Authorize()                                                        | 1 @Sse() job stream. Stream session CRUD + TenantOwnedResource.                     |
| **AudioPipelineController**         | `api/v1/admin/audio/pipelines`          | 14   | JWT + API key | scope `admin:audio-pipeline:manage` jwt: manage:AsrPipeline                                              | YAML validate, clone, tenant assign, versions.                                      |
| **SttInternalController**           | `api/v1/internal/stt`                   | 10   | JWT + API key | scope `internal:stt:worker (X-Internal-Service-Key)` jwt: @Authorize() — worker rejects JWT in handler   | Exception to /internal Public+token pattern. Tenant pin needs platform key.         |
| **TenantSttConfigAdminController**  | `api/v1/admin/stt-config`               | 8    | JWT + API key | scope `admin:tenant-stt-config:manage` jwt: read/manage:TenantSttConfig                                  | Effective + row + credentials test.                                                 |
| **SttWsGateway**                    | `/ws/stt/stream (no api/v1)`            | 6    | Stream ticket | **no key path** — `?ticket=` scoped `stt_session:<id>` jwt: n/a — Nest APP_GUARD does not run            | Raw ws. Origin check + Redis tenant binding. Binary + JSON audio/stop/resume/close. |
| **VoiceProfileController**          | `api/v1/voice-profile`                  | 5    | JWT only      | **API key forbidden** jwt: per-verb UserVoiceProfile                                                     | TenantOwnedResource on mutate/delete.                                               |
| **SttCompatGateway**                | `/stt (no api/v1)`                      | 4    | API key (WS)  | scope `WS headers apikey/api-key/x-api-key/x-internal-service-key, or query apiKey/api-key/key` jwt: n/a | Legacy v1. Session tenant must match key tenant.                                    |
| **AdminTranscriptionJobController** | `api/v1/admin/audio/transcription-jobs` | 3    | JWT + API key | scope `admin:transcription-job:read` jwt: class manage:Tenant; handlers read:AsrPipeline                 | Admin usages only, API key should not be here.                                      |
| **AudioPipelinePublicController**   | `api/v1/audio/pipelines`                | 3    | JWT + API key      | **API key `stt:model:read`** jwt: @Authorize()                                                                  | Read-only catalog for clinicians.                                                   |
| **SttCompatController**             | `api/stt (prefix excluded)`             | 3    | JWT + API key | scope `stt:stream:write` jwt: @Authorize()                                                               | Live paths: POST /api/stt/{start_session,switch,stop_session}.                      |




### SUM — Standalone summarization / text

Text generation and summarization without a consultation session, plus the prompt and writing-style assets that shape it. `api/smr/api/v1` is the v1 compat path and is prefix-excluded.

*8 controllers · 59 handlers*


| Controller                             | Prefix                               | APIs | Auth model    | Access scope                                                                            | Notes                                                                                   |
| -------------------------------------- | ------------------------------------ | ---- | ------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **PromptManagementController**         | `api/v1/admin/prompt-templates`      | 16   | JWT + API key | scope `admin:prompt-template:manage` jwt: manage:PromptTemplate (method Can* overrides) | Approve is SYSTEM-row SUPER_ADMIN in service. Assign-department uses manage:Department. |
| **DnaWritingStyleController**          | `api/v1/dna-writing-styles`          | 14   | JWT only      | **API key forbidden** (@ForbidApiKey) jwt: @Authorize(); owner/doctor checks in service | SSE job stream has no @StreamScope — ticket will 401.                                   |
| **DnaWritingStyleAdminController**     | `api/v1/admin/dna-writing-styles`    | 8    | JWT + API key | scope `admin:dna-writing-style:manage` jwt: manage:DnaWritingStyleReport                | SSE job stream with StreamScope dna_job.                                                |
| **TextProxyController**                | `api/v1/text`                        | 7    | JWT + API key | scope `consultation:report:write` jwt: @Authorize()                                     | Hand-rolled SSE on GET tasks/:taskId/stream (StreamScope text_task).                    |
| **AiInferenceController**              | `api/v1/ai`                          | 5    | JWT + API key      | **API key `ai:inference:write`** jwt: @Authorize()                                                 | Guardrail + NLP proxy.                                                                  |
| **PromptTemplateController**           | `api/v1/prompt-templates`            | 5    | JWT + API key      | **API key `prompt:template:read`** jwt: read:PromptTemplate (writes owner-gated in service)          | Clinician plane — AUTH-NOTE: declared read, ownership in service.                       |
| **NlpTaskInstructionsAdminController** | `api/v1/admin/nlp-task-instructions` | 2    | JWT + API key | scope `admin:nlp-task-instructions:manage` jwt: read/manage:TenantNlpTaskInstructions   | No class @Authorize; per-handler CASL.                                                  |
| **TextCompatController**               | `api/smr/api/v1 (prefix excluded)`   | 2    | JWT + API key | scope `consultation:report:write` jwt: @Authorize()                                     | POST /api/smr/api/v1/{summary/sync,presummary}. SSE if body.stream===true.              |




### AGENT — Agentic consultation

The consultation session itself and everything the agent runs on: harness policy + Temporal ops, workflow definitions/runs, department agents, knowledge, MCP servers, and the consent gate.

*23 controllers · 170 handlers*


| Controller                                   | Prefix                                                         | APIs | Auth model    | Access scope                                                                                           | Notes                                                                                |
| -------------------------------------------- | -------------------------------------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **ConsultationController**                   | `api/v1/consultations`                                         | 51   | JWT + API key | scope `consultation:session:write (read/report overrides)` jwt: @Authorize(); some create:Consultation | Largest surface. 5 @Sse() streams + StreamScope. Consent on history/prime/recording. |
| **HarnessAdminController**                   | `api/v1/admin/harness`                                         | 26   | JWT + API key | scope `admin:harness:manage` jwt: per-method HarnessPolicy / Eval / Workflow / Audit                   | Policy, golden sets, Temporal workflow ops, live sessions.                           |
| **HarnessInternalController**                | `api/v1/internal/harness`                                      | 18   | Service token | **no key path** — X-Service-Token (HarnessServiceTokenGuard) jwt: skipped (@Public)                    | Harness worker callbacks. UnifiedAuth skipped.                                       |
| **DepartmentAgentController**                | `api/v1/admin/department-agents`                               | 9    | JWT + API key | scope `admin:department-agent:manage` jwt: manage:DepartmentAgent                                      | Shares prefix with resync controller.                                                |
| **ConsultationContextSchemaAdminController** | `api/v1/admin/consultation-context-schemas`                    | 8    | JWT + API key | scope `admin:consultation-context-schema:manage` jwt: manage:ConsultationContextSchema                 | Same file as MyTenantContextSchemaController.                                        |
| **WorkflowDefinitionController**             | `api/v1/admin/workflow-definitions`                            | 8    | JWT + API key | scope `admin:workflow-definition:manage` jwt: manage:WorkflowDefinition                                | Validate + publish.                                                                  |
| **KnowledgeController**                      | `api/v1/admin/knowledge/documents`                             | 5    | JWT + API key | scope `admin:knowledge:manage` jwt: manage:KnowledgeDocument (chunks → read)                           | Qdrant cleanup fail-closed on delete.                                                |
| **McpAdminController**                       | `api/v1/admin/mcp-servers`                                     | 5    | JWT + API key | scope `admin:mcp-server:manage` jwt: read/manage:McpServer                                             | Writes SUPER_ADMIN-only in service.                                                  |
| **WorkflowTestFixtureController**            | `api/v1/admin/workflow-test-fixtures`                          | 5    | JWT + API key | scope `admin:workflow-test-fixture:manage` jwt: manage:WorkflowTestFixture                             | —                                                                                    |
| **WorkflowsController**                      | `api/v1/workflows`                                             | 5    | JWT + API key | scope `workflow:definition:read / workflow:run:read                                                    | write` jwt: per-route WorkflowDefinition / WorkflowRun                               |
| **WorkflowSandboxRunController**             | `api/v1/admin/workflow-definitions/:definitionId/sandbox-runs` | 4    | JWT + API key | scope `admin:workflow-definition:manage` jwt: per-method WorkflowRun Can*                              | Hand-rolled SSE + StreamScope workflow_run.                                          |
| **AdminConsultationController**              | `api/v1/admin/consultations`                                   | 3    | JWT + API key | scope `admin:consultation-admin:manage` jwt: manage:Consultation                                       | Tenant-wide list/aggregate.                                                          |
| **AgentPromotionController**                 | `api/v1/admin/agent-promotions`                                | 3    | JWT + API key | scope `admin:agent-promotion:manage` jwt: manage:DepartmentAgent                                       | POST requires manage in both tenants (service).                                      |
| **AgentTrajectoryController**                | `api/v1/admin/agent-trajectory`                                | 3    | JWT + API key | scope `admin:agent-trajectory:read` jwt: read:AgentTrajectory                                          | —                                                                                    |
| **ConsentGrantController**                   | `api/v1/admin/consent-grants`                                  | 3    | JWT only      | **API key forbidden** jwt: manage:ConsentGrant                                                         | Human-only consent admin. `@ForbidApiKey()`.                                         |
| **ConsultationJobController**                | `api/v1/consultations/jobs`                                    | 3    | JWT + API key | scope `consultation:session:read` jwt: @Authorize()                                                    | 1 SSE + TenantOwnedResource.                                                         |
| **PipelinePolicyAdminController**            | `api/v1/admin/harness/pipeline-policy`                         | 3    | JWT + API key | scope `admin:pipeline-policy:manage` jwt: read/manage:PipelinePolicy                                   | —                                                                                    |
| **WorkflowRunController**                    | `api/v1/admin/workflow-runs`                                   | 3    | JWT + API key | scope `admin:workflow-run:read` jwt: read:WorkflowRun                                                  | Working-tenant CLS required.                                                         |
| **AgenticAdminController**                   | `api/v1/admin/agentic`                                         | 1    | JWT + API key | scope `admin:agentic:manage` jwt: @Authorize() + manage:HarnessPolicy                                  | GET instructions.                                                                    |
| **ConsentInternalController**                | `api/v1/internal/consent`                                      | 1    | Service token | **no key path** — X-Service-Token (HarnessServiceTokenGuard) jwt: skipped (@Public)                    | POST assert.                                                                         |
| **DepartmentAgentResyncController**          | `api/v1/admin/department-agents`                               | 1    | JWT + API key | scope `admin:department-agent:manage` jwt: manage:Tenant                                               | SUPER_ADMIN resync.                                                                  |
| **MyTenantContextSchemaController**          | `api/v1/tenant/me/context-schema`                              | 1    | JWT + API key      | **API key `tenant:context-schema:read`** jwt: @Authorize()                                                                | Same file as ConsultationContextSchemaAdminController.                               |
| **WorkflowNodeController**                   | `api/v1/admin/workflow-nodes`                                  | 1    | JWT + API key | scope `admin:workflow-node:read` jwt: read:WorkflowDefinition                                          | Read-only registry.                                                                  |




### TTS — speech synthesis (adjacent)

Not one of the three named lines, but the fourth media capability — listed separately rather than buried in the platform residual.

*3 controllers · 14 handlers*


| Controller                         | Prefix                       | APIs | Auth model    | Access scope                                                                             | Notes                                                  |
| ---------------------------------- | ---------------------------- | ---- | ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **TenantTtsConfigAdminController** | `api/v1/admin/tts-config`    | 7    | JWT + API key | scope `admin:tenant-tts-config:manage` jwt: read/manage:TenantTtsConfig                  | Catalog + credentials.                                 |
| **TtsWsGateway**                   | `/ws/tts/stream (no api/v1)` | 5    | Stream ticket | **no key path** — `?ticket=` scoped `tts_session:<id>` jwt: n/a — APP_GUARD does not run | No Redis tenant-binding cross-check. Quota close 4429. |
| **SpeechProxyController**          | `api/v1/speech`              | 2    | JWT + API key | scope `tts:speech:write` jwt: @Authorize()                                               | Synthesize may be SSE or audio bytes.                  |




### AI runtime shared by all three

Model catalog, provider connections, runtime profiles and task defaults. Tenant→SYSTEM resolution lives here, so a change here moves STT, summarization and consultation at once.

*7 controllers · 29 handlers*


| Controller                         | Prefix                             | APIs | Auth model    | Access scope                                                        | Notes                                        |
| ---------------------------------- | ---------------------------------- | ---- | ------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| **AiModelAdminController**         | `api/v1/admin/ai-models`           | 7    | JWT + API key | scope `admin:ai-model:manage` jwt: manage:all                       | Shares prefix with discovery controller.     |
| **AiRuntimeProfileController**     | `api/v1/admin/ai-runtime-profiles` | 5    | JWT + API key | scope `admin:ai-runtime-profile:manage` jwt: manage:all             | SUPER_ADMIN / SYSTEM rows.                   |
| **AiProviderConnectionController** | `api/v1/admin/ai-providers`        | 4    | JWT + API key | scope `admin:ai-provider:manage` jwt: read/manage:GlobalSetting     | Legacy LLM alias (service=llm).              |
| **AiTaskDefaultAdminController**   | `api/v1/admin/ai-task-defaults`    | 4    | JWT + API key | scope `admin:ai-task-default:manage` jwt: read/manage:AiTaskDefault | Some keys SUPER_ADMIN in service.            |
| **ProviderConnectionController**   | `api/v1/admin/providers`           | 4    | JWT + API key | scope `admin:ai-provider:manage` jwt: read/manage:GlobalSetting     | Same file as AiProviderConnectionController. |
| **AiServiceAdminController**       | `api/v1/admin/ai-services`         | 3    | JWT + API key | scope `admin:ai-service:manage` jwt: manage:all                     | Read-only guardrail/NLP status proxy.        |
| **AiModelDiscoveryController**     | `api/v1/admin/ai-models`           | 2    | JWT + API key | scope `admin:ai-model:manage` jwt: manage:all                       | —                                            |




### PLATFORM — not a business capability

Residual: auth, tenancy, RBAC, billing, storage, settings, ops, user self-service. Included so the view stays complete.

*57 controllers · 272 handlers* (TASK-759 split `ApiHealthController` 6 → 4 + `AdminHealthServicesController` 2; handler total unchanged)


| Controller                              | Prefix                                 | APIs | Auth model    | Access scope                                                                         | Notes                                                                                                |
| --------------------------------------- | -------------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **UserController**                      | `api/v1/admin/users`                   | 21   | JWT + API key | scope `admin:user:write` jwt: manage:User (assign-role → UserRoleAssignment)         | Shares prefix with UserDepartments + AdminImpersonation.                                             |
| **TenantController**                    | `api/v1/admin/tenants`                 | 15   | JWT + API key | scope `admin:tenant:write` jwt: manage                                               | update:Tenant (lifecycle = manage)                                                                   |
| **QueueAdminController**                | `api/v1/admin/queues`                  | 12   | JWT + API key | scope `admin:queue:manage` jwt: manage:all                                           | SUPER_ADMIN BullMQ ops.                                                                              |
| **TenantBucketController**              | `api/v1/admin/tenants/storage/buckets` | 12   | JWT + API key | scope `admin:tenant-storage:manage` jwt: class manage:Tenant; methods Can*:Storage   | TenantOwnedResource on named buckets.                                                                |
| **EntitlementsAdminController**         | `api/v1/admin/entitlements`            | 11   | JWT + API key | scope `admin:entitlement:manage` jwt: manage:all                                     | Plans, tenant overrides, trial expiry.                                                               |
| **DepartmentController**                | `api/v1/admin/departments`             | 10   | JWT + API key | scope `admin:department:manage` jwt: manage:Department                               | Tree + users + prompt-config OCC.                                                                    |
| **RolesController**                     | `api/v1/admin/rbac/roles`              | 10   | JWT + API key | scope `admin:role:write` jwt: manage:Role (reads CanAny read                         | manage)                                                                                              |
| **StorageController**                   | `api/v1/storage`                       | 10   | JWT + API key | scope `media:file:write` jwt: per-verb Storage                                       | MinIO/S3. TenantOwnedResource on named buckets.                                                      |
| **ApiKeyController**                    | `api/v1/admin/api-keys`                | 9    | JWT + API key | scope `admin:apikey:write` jwt: manage:ApiKey + per-verb Can*                        | Create/rotate/revoke plus scopes catalog.                                                            |
| **GlobalSettingController**             | `api/v1/admin/settings`                | 8    | JWT + API key | scope `admin:settings:manage` jwt: manage:GlobalSetting (reveal/rotate → manage:all) | Shares prefix with catalog + registry-write.                                                         |
| **TenantIdpConfigAdminController**      | `api/v1/admin/tenant-idp-config`       | 8    | JWT + API key | scope `admin:tenant-idp-config:manage` jwt: read/manage:TenantIdentityProvider       | Test + directory sync.                                                                               |
| **AuthController**                      | `api/v1/auth`                          | 7    | Mixed         | **API key forbidden** jwt: class @ForbidApiKey; login+refresh @Public                | Public: POST login, POST refresh. JWT: logout, me, impersonate, stream-ticket, revoke-impersonation. |
| **BillingAdminController**              | `api/v1/admin/billing/invoices`        | 7    | JWT + API key | scope `admin:billing:manage` jwt: manage:BillingInvoice                              | Mutations SUPER_ADMIN in service.                                                                    |
| **PoliciesController**                  | `api/v1/admin/rbac/policies`           | 7    | JWT + API key | scope `admin:rbac-policy:write` jwt: manage:Policy (GETs CanAny read                 | manage)                                                                                              |
| **WebhookController**                   | `api/v1/admin/webhooks`                | 7    | JWT + API key | scope `webhook:event:write` jwt: manage:Webhook (deliveries read:WebhookRunHistory)  | Rotate-secret OCC.                                                                                   |
| **ApiHealthController**                 | `api/v1/health`                        | 4    | Public        | **no key path** jwt: none — every route @Public()                                    | PUBLIC-ONLY since TASK-759. k3s probes.                                                              |
| **AdminHealthServicesController**       | `api/v1/admin/health/services`         | 2    | JWT only      | **API key forbidden** jwt: CanAny manage:all \| read:TenantTelemetry                 | Split off ApiHealthController by TASK-759 (P2). 30/60s throttle.                                     |
| **AuditLogController**                  | `api/v1/admin/audit-logs`              | 6    | JWT + API key | scope `admin:audit:read` jwt: read:AuditLog                                          | Non-SUPER_ADMIN needs tenant context.                                                                |
| **ResourceSubscriptionController**      | `api/v1/admin/resource-subscriptions`  | 6    | JWT + API key | scope `admin:resource-subscription:manage` jwt: manage:ResourceSubscription          | Tenant-scoped in service.                                                                            |
| **TenantAllowedOriginController**       | `api/v1/admin/allowed-origins`         | 6    | JWT + API key | scope `admin:allowed-origin:manage` jwt: manage:TenantAllowedOrigin                  | Wildcard origins SUPER_ADMIN in service.                                                             |
| **TenantStorageConfigAdminController**  | `api/v1/admin/tenants/storage/config`  | 6    | JWT + API key | scope `admin:tenant-storage:manage` jwt: manage                                      | update:Tenant; methods Can*:Storage                                                                  |
| **AuthSsoController**                   | `api/v1/auth/sso`                      | 5    | Public        | **no key path** jwt: none (@Public)                                                  | OIDC + SAML start/callback/ACS. Throttled.                                                           |
| **SchedulerAdminController**            | `api/v1/admin/schedulers`              | 5    | JWT + API key | scope `admin:scheduler:manage` jwt: manage:all                                       | Pause/resume/cron/toggle.                                                                            |
| **AdminUsageController**                | `api/v1/admin/usage`                   | 4    | JWT + API key | scope `admin:usage:manage` jwt: manage:UsageAnalytics                                | top-tenants SUPER_ADMIN in service.                                                                  |
| **MonitoringController**                | `api/v1/admin/monitoring`              | 4    | JWT only      | **API key forbidden** jwt: CanAny manage:all \| read:TenantTelemetry                 | Moved under /admin by TASK-759 (P2). Hard move — old paths 404.                                      |
| **NotificationController**              | `api/v1/admin/notifications`           | 4    | JWT + API key | scope `admin:notification:manage` jwt: manage:Notification                           | No create route.                                                                                     |
| **RateLimitAdminController**            | `api/v1/admin/rate-limit`              | 4    | JWT + API key | scope `admin:rate-limit:manage` jwt: manage:all                                      | SUPER_ADMIN policy editor.                                                                           |
| **UserDepartmentsController**           | `api/v1/admin/users`                   | 4    | JWT + API key | scope `admin:user:write` jwt: manage:User                                            | :id/departments assign/unassign.                                                                     |
| **AdminReconciliationController**       | `api/v1/admin/usage/reconciliation`    | 3    | JWT + API key | scope `admin:usage:manage` jwt: manage:UsageAnalytics                                | —                                                                                                    |
| **ChangelogAdminController**            | `api/v1/admin/changelog`               | 3    | JWT + API key | scope `admin:changelog:manage` jwt: manage:ChangelogEntry                            | SUPER_ADMIN in service.                                                                              |
| **ChangelogController**                 | `api/v1/changelog`                     | 3    | JWT + API key      | **API key `platform:changelog:read`** jwt: @Authorize() (any authenticated user)                     | Reader plane.                                                                                        |
| **MyBillingController**                 | `api/v1/billing`                       | 3    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                               | CLS tenant only. 404-over-403 on foreign invoice.                                                    |
| **MyTenantController**                  | `api/v1/tenant`                        | 3    | JWT + API key      | **API key `tenant:profile:read`** jwt: @Authorize(); PATCH update:Tenant                         | —                                                                                                    |
| **PermissionCheckController**           | `api/v1/rbac/check`                    | 3    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize(); other-user checks need manage:User          | —                                                                                                    |
| **PlatformMetricsController**           | `api/v1/admin/platform`                | 3    | JWT + API key | scope `admin:platform-metrics:read` jwt: manage:PlatformMetrics                      | SUPER_ADMIN via manage:all.                                                                          |
| **RateCardAdminController**             | `api/v1/admin/billing/rate-card`       | 3    | JWT + API key | scope `admin:billing:manage` jwt: manage:AiPriceBook                                 | Mutations SUPER_ADMIN in service.                                                                    |
| **ServiceReleaseAdminController**       | `api/v1/admin/service-releases`        | 3    | JWT + API key | scope `admin:service-release:manage` jwt: CanAny manage:all                          | read:TenantTelemetry                                                                                 |
| **StorageAccessKeyController**          | `api/v1/admin/tenants/storage/keys`    | 3    | JWT + API key | scope `admin:storage-key:manage` jwt: class manage:Tenant; methods Can*:Storage      | —                                                                                                    |
| **MyUsageController**                   | `api/v1/usage`                         | 2    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                               | No tenantId override.                                                                                |
| **PrismaStudioController**              | `api/v1/admin/pstudio`                 | 2    | JWT + API key | scope `admin:pstudio:manage` jwt: manage:PrismaStudio                                | HTML shell + BFF POST. Not public.                                                                   |
| **RegisterController**                  | `api/v1/auth`                          | 2    | Public        | **no key path** jwt: none                                                            | 404 if self-signup flag off. Throttled.                                                              |
| **ServiceReleaseInternalController**    | `api/v1/internal/service-releases`     | 2    | Service token | **no key path** — X-Service-Token (any known service secret) jwt: skipped (@Public)  | —                                                                                                    |
| **SettingsCatalogController**           | `api/v1/admin/settings`                | 2    | JWT + API key | scope `admin:settings:manage` jwt: read:GlobalSetting                                | —                                                                                                    |
| **SettingsRegistryWriteController**     | `api/v1/admin/settings`                | 2    | JWT + API key | scope `admin:settings:manage` jwt: read/manage:GlobalSetting                         | PUT uses ExpectedVersion, not RequiresIfMatch.                                                       |
| **TenantFrontendConfigAdminController** | `api/v1/admin/tenant-frontend-config`  | 2    | JWT + API key | scope `admin:tenant-frontend-config:manage` jwt: manage                              | update:Tenant                                                                                        |
| **UserPreferencesController**           | `api/v1/user/me/preferences`           | 2    | JWT + API key | scope `user:preferences:write` jwt: @Authorize()                                     | Self CLS user.                                                                                       |
| **UserSettingsController**              | `api/v1/user/me/settings`              | 2    | JWT + API key      | **API key `user:settings:read`** jwt: @Authorize()                                              | —                                                                                                    |
| **AdminImpersonationController**        | `api/v1/admin/users`                   | 1    | JWT only      | **API key forbidden** jwt: manage:all                                                | SUPER_ADMIN impersonation. Throttled.                                                                |
| **EffectiveConfigController**           | `api/v1/internal/effective-config`     | 1    | Service token | **no key path** — X-Service-Token (InternalServiceTokenGuard) jwt: skipped (@Public) | —                                                                                                    |
| **ForgotPasswordController**            | `api/v1/auth`                          | 1    | Public        | **no key path** jwt: none                                                            | Throttled 5/min.                                                                                     |
| **MyEntitlementsController**            | `api/v1/entitlements`                  | 1    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                               | —                                                                                                    |
| **PasswordResetController**             | `api/v1/users/password-reset`          | 1    | Public        | **no key path** jwt: none                                                            | POST complete. Token in body.                                                                        |
| **PrismaStudioStatusController**        | `api/v1/admin/pstudio/status`          | 1    | JWT + API key | scope `admin:pstudio:manage` jwt: manage:PrismaStudio                                | —                                                                                                    |
| **TenantPipelineResyncController**      | `api/v1/admin/tenants`                 | 1    | JWT + API key | scope `admin:tenant:write` jwt: manage:Tenant                                        | SUPER_ADMIN.                                                                                         |
| **TenantProvisionController**           | `api/v1/admin/tenants`                 | 1    | JWT + API key | scope `admin:tenant:write` jwt: manage:Tenant                                        | SUPER_ADMIN.                                                                                         |
| **UserDepartmentsMeController**         | `api/v1/user/me/departments`           | 1    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize()                                              | —                                                                                                    |
| **UserRolesController**                 | `api/v1/users`                         | 1    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize(); :id must equal caller                       | —                                                                                                    |




---



## View B — by admin scope

Audience tier answers **who may open the surface**; API-key reachability is an orthogonal auth mechanism, so it stays in the Access scope column instead of becoming a tier of its own. `SUPER-CARVE` is separated out because those surfaces are genuinely tenant-admin for most operations, with a SUPER_ADMIN-only subset enforced imperatively in the service.

### SUPER — super-admin only (platform plane)

Cross-tenant platform operations. Most declare `manage:all`; the rest enforce `isSuperAdmin` in the service. These are 403 privilege boundaries, never the 404-over-403 cross-tenant posture.

*18 controllers · 70 handlers*


| Controller                          | Prefix                             | APIs | Auth model    | Access scope                                                    | Notes                                    |
| ----------------------------------- | ---------------------------------- | ---- | ------------- | --------------------------------------------------------------- | ---------------------------------------- |
| **QueueAdminController**            | `api/v1/admin/queues`              | 12   | JWT + API key | scope `admin:queue:manage` jwt: manage:all                      | SUPER_ADMIN BullMQ ops.                  |
| **EntitlementsAdminController**     | `api/v1/admin/entitlements`        | 11   | JWT + API key | scope `admin:entitlement:manage` jwt: manage:all                | Plans, tenant overrides, trial expiry.   |
| **AiModelAdminController**          | `api/v1/admin/ai-models`           | 7    | JWT + API key | scope `admin:ai-model:manage` jwt: manage:all                   | Shares prefix with discovery controller. |
| **AiRuntimeProfileController**      | `api/v1/admin/ai-runtime-profiles` | 5    | JWT + API key | scope `admin:ai-runtime-profile:manage` jwt: manage:all         | SUPER_ADMIN / SYSTEM rows.               |
| **McpAdminController**              | `api/v1/admin/mcp-servers`         | 5    | JWT + API key | scope `admin:mcp-server:manage` jwt: read/manage:McpServer      | Writes SUPER_ADMIN-only in service.      |
| **SchedulerAdminController**        | `api/v1/admin/schedulers`          | 5    | JWT + API key | scope `admin:scheduler:manage` jwt: manage:all                  | Pause/resume/cron/toggle.                |
| **RateLimitAdminController**        | `api/v1/admin/rate-limit`          | 4    | JWT + API key | scope `admin:rate-limit:manage` jwt: manage:all                 | SUPER_ADMIN policy editor.               |
| **AiServiceAdminController**        | `api/v1/admin/ai-services`         | 3    | JWT + API key | scope `admin:ai-service:manage` jwt: manage:all                 | Read-only guardrail/NLP status proxy.    |
| **ChangelogAdminController**        | `api/v1/admin/changelog`           | 3    | JWT + API key | scope `admin:changelog:manage` jwt: manage:ChangelogEntry       | SUPER_ADMIN in service.                  |
| **PlatformMetricsController**       | `api/v1/admin/platform`            | 3    | JWT + API key | scope `admin:platform-metrics:read` jwt: manage:PlatformMetrics | SUPER_ADMIN via manage:all.              |
| **ServiceReleaseAdminController**   | `api/v1/admin/service-releases`    | 3    | JWT + API key | scope `admin:service-release:manage` jwt: CanAny manage:all     | read:TenantTelemetry                     |
| **AiModelDiscoveryController**      | `api/v1/admin/ai-models`           | 2    | JWT + API key | scope `admin:ai-model:manage` jwt: manage:all                   | —                                        |
| **PrismaStudioController**          | `api/v1/admin/pstudio`             | 2    | JWT + API key | scope `admin:pstudio:manage` jwt: manage:PrismaStudio           | HTML shell + BFF POST. Not public.       |
| **AdminImpersonationController**    | `api/v1/admin/users`               | 1    | JWT only      | **API key forbidden** jwt: manage:all                           | SUPER_ADMIN impersonation. Throttled.    |
| **DepartmentAgentResyncController** | `api/v1/admin/department-agents`   | 1    | JWT + API key | scope `admin:department-agent:manage` jwt: manage:Tenant        | SUPER_ADMIN resync.                      |
| **PrismaStudioStatusController**    | `api/v1/admin/pstudio/status`      | 1    | JWT + API key | scope `admin:pstudio:manage` jwt: manage:PrismaStudio           | —                                        |
| **TenantPipelineResyncController**  | `api/v1/admin/tenants`             | 1    | JWT + API key | scope `admin:tenant:write` jwt: manage:Tenant                   | SUPER_ADMIN.                             |
| **TenantProvisionController**       | `api/v1/admin/tenants`             | 1    | JWT + API key | scope `admin:tenant:write` jwt: manage:Tenant                   | SUPER_ADMIN.                             |




### SUPER-CARVE — tenant-admin surface with a SUPER_ADMIN-only subset

Tenant admins hold the resource ability for ordinary operations; specific keys, rows or mutations are super-admin-only in the service. The two TASK-759 arrivals fit the same shape via `CanAny(manage:all | read:TenantTelemetry)`: platform-wide payload, tenant-admin-readable, super-admin by `manage:all`.

*15 controllers · 75 handlers* (+`MonitoringController` 4 and `AdminHealthServicesController` 2, TASK-759)


| Controller                             | Prefix                                | APIs | Auth model    | Access scope                                                                            | Notes                                                                                   |
| -------------------------------------- | ------------------------------------- | ---- | ------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **PromptManagementController**         | `api/v1/admin/prompt-templates`       | 16   | JWT + API key | scope `admin:prompt-template:manage` jwt: manage:PromptTemplate (method Can* overrides) | Approve is SYSTEM-row SUPER_ADMIN in service. Assign-department uses manage:Department. |
| **MonitoringController**               | `api/v1/admin/monitoring`             | 4    | JWT only      | **API key forbidden** jwt: CanAny manage:all \| read:TenantTelemetry                     | Moved onto the admin plane by TASK-759 (P2). SUPER_ADMIN via `manage:all`; a TENANT_ADMIN reads it via `read:TenantTelemetry`; a DOCTOR is 403. |
| **AdminHealthServicesController**      | `api/v1/admin/health/services`        | 2    | JWT only      | **API key forbidden** jwt: CanAny manage:all \| read:TenantTelemetry                     | Same gate, same move — split off `ApiHealthController` by TASK-759 (P2).                |
| **GlobalSettingController**            | `api/v1/admin/settings`               | 8    | JWT + API key | scope `admin:settings:manage` jwt: manage:GlobalSetting (reveal/rotate → manage:all)    | Shares prefix with catalog + registry-write.                                            |
| **BillingAdminController**             | `api/v1/admin/billing/invoices`       | 7    | JWT + API key | scope `admin:billing:manage` jwt: manage:BillingInvoice                                 | Mutations SUPER_ADMIN in service.                                                       |
| **TenantAllowedOriginController**      | `api/v1/admin/allowed-origins`        | 6    | JWT + API key | scope `admin:allowed-origin:manage` jwt: manage:TenantAllowedOrigin                     | Wildcard origins SUPER_ADMIN in service.                                                |
| **TenantStorageConfigAdminController** | `api/v1/admin/tenants/storage/config` | 6    | JWT + API key | scope `admin:tenant-storage:manage` jwt: manage                                         | update:Tenant; methods Can*:Storage                                                     |
| **AdminUsageController**               | `api/v1/admin/usage`                  | 4    | JWT + API key | scope `admin:usage:manage` jwt: manage:UsageAnalytics                                   | top-tenants SUPER_ADMIN in service.                                                     |
| **AiProviderConnectionController**     | `api/v1/admin/ai-providers`           | 4    | JWT + API key | scope `admin:ai-provider:manage` jwt: read/manage:GlobalSetting                         | Legacy LLM alias (service=llm).                                                         |
| **AiTaskDefaultAdminController**       | `api/v1/admin/ai-task-defaults`       | 4    | JWT + API key | scope `admin:ai-task-default:manage` jwt: read/manage:AiTaskDefault                     | Some keys SUPER_ADMIN in service.                                                       |
| **ProviderConnectionController**       | `api/v1/admin/providers`              | 4    | JWT + API key | scope `admin:ai-provider:manage` jwt: read/manage:GlobalSetting                         | Same file as AiProviderConnectionController.                                            |
| **AdminReconciliationController**      | `api/v1/admin/usage/reconciliation`   | 3    | JWT + API key | scope `admin:usage:manage` jwt: manage:UsageAnalytics                                   | —                                                                                       |
| **RateCardAdminController**            | `api/v1/admin/billing/rate-card`      | 3    | JWT + API key | scope `admin:billing:manage` jwt: manage:AiPriceBook                                    | Mutations SUPER_ADMIN in service.                                                       |
| **SettingsCatalogController**          | `api/v1/admin/settings`               | 2    | JWT + API key | scope `admin:settings:manage` jwt: read:GlobalSetting                                   | —                                                                                       |
| **SettingsRegistryWriteController**    | `api/v1/admin/settings`               | 2    | JWT + API key | scope `admin:settings:manage` jwt: read/manage:GlobalSetting                            | PUT uses ExpectedVersion, not RequiresIfMatch.                                          |




### TENANT — tenant-admin console plane

`/admin/*` surfaces scoped to the caller's tenant via CLS. A cross-tenant id returns 404, not 403.

*36 controllers · 251 handlers*


| Controller                                   | Prefix                                                         | APIs | Auth model    | Access scope                                                                             | Notes                                                      |
| -------------------------------------------- | -------------------------------------------------------------- | ---- | ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **HarnessAdminController**                   | `api/v1/admin/harness`                                         | 26   | JWT + API key | scope `admin:harness:manage` jwt: per-method HarnessPolicy / Eval / Workflow / Audit     | Policy, golden sets, Temporal workflow ops, live sessions. |
| **UserController**                           | `api/v1/admin/users`                                           | 21   | JWT + API key | scope `admin:user:write` jwt: manage:User (assign-role → UserRoleAssignment)             | Shares prefix with UserDepartments + AdminImpersonation.   |
| **TenantController**                         | `api/v1/admin/tenants`                                         | 15   | JWT + API key | scope `admin:tenant:write` jwt: manage                                                   | update:Tenant (lifecycle = manage)                         |
| **AudioPipelineController**                  | `api/v1/admin/audio/pipelines`                                 | 14   | JWT + API key | scope `admin:audio-pipeline:manage` jwt: manage:AsrPipeline                              | YAML validate, clone, tenant assign, versions.             |
| **TenantBucketController**                   | `api/v1/admin/tenants/storage/buckets`                         | 12   | JWT + API key | scope `admin:tenant-storage:manage` jwt: class manage:Tenant; methods Can*:Storage       | TenantOwnedResource on named buckets.                      |
| **DepartmentController**                     | `api/v1/admin/departments`                                     | 10   | JWT + API key | scope `admin:department:manage` jwt: manage:Department                                   | Tree + users + prompt-config OCC.                          |
| **RolesController**                          | `api/v1/admin/rbac/roles`                                      | 10   | JWT + API key | scope `admin:role:write` jwt: manage:Role (reads CanAny read                             | manage)                                                    |
| **ApiKeyController**                         | `api/v1/admin/api-keys`                                        | 9    | JWT + API key | scope `admin:apikey:write` jwt: manage:ApiKey + per-verb Can*                            | Create/rotate/revoke plus scopes catalog.                  |
| **DepartmentAgentController**                | `api/v1/admin/department-agents`                               | 9    | JWT + API key | scope `admin:department-agent:manage` jwt: manage:DepartmentAgent                        | Shares prefix with resync controller.                      |
| **ConsultationContextSchemaAdminController** | `api/v1/admin/consultation-context-schemas`                    | 8    | JWT + API key | scope `admin:consultation-context-schema:manage` jwt: manage:ConsultationContextSchema   | Same file as MyTenantContextSchemaController.              |
| **DnaWritingStyleAdminController**           | `api/v1/admin/dna-writing-styles`                              | 8    | JWT + API key | scope `admin:dna-writing-style:manage` jwt: manage:DnaWritingStyleReport                 | SSE job stream with StreamScope dna_job.                   |
| **TenantIdpConfigAdminController**           | `api/v1/admin/tenant-idp-config`                               | 8    | JWT + API key | scope `admin:tenant-idp-config:manage` jwt: read/manage:TenantIdentityProvider           | Test + directory sync.                                     |
| **TenantSttConfigAdminController**           | `api/v1/admin/stt-config`                                      | 8    | JWT + API key | scope `admin:tenant-stt-config:manage` jwt: read/manage:TenantSttConfig                  | Effective + row + credentials test.                        |
| **WorkflowDefinitionController**             | `api/v1/admin/workflow-definitions`                            | 8    | JWT + API key | scope `admin:workflow-definition:manage` jwt: manage:WorkflowDefinition                  | Validate + publish.                                        |
| **PoliciesController**                       | `api/v1/admin/rbac/policies`                                   | 7    | JWT + API key | scope `admin:rbac-policy:write` jwt: manage:Policy (GETs CanAny read                     | manage)                                                    |
| **TenantTtsConfigAdminController**           | `api/v1/admin/tts-config`                                      | 7    | JWT + API key | scope `admin:tenant-tts-config:manage` jwt: read/manage:TenantTtsConfig                  | Catalog + credentials.                                     |
| **WebhookController**                        | `api/v1/admin/webhooks`                                        | 7    | JWT + API key | scope `webhook:event:write` jwt: manage:Webhook (deliveries read:WebhookRunHistory)      | Rotate-secret OCC.                                         |
| **AuditLogController**                       | `api/v1/admin/audit-logs`                                      | 6    | JWT + API key | scope `admin:audit:read` jwt: read:AuditLog                                              | Non-SUPER_ADMIN needs tenant context.                      |
| **ResourceSubscriptionController**           | `api/v1/admin/resource-subscriptions`                          | 6    | JWT + API key | scope `admin:resource-subscription:manage` jwt: manage:ResourceSubscription              | Tenant-scoped in service.                                  |
| **KnowledgeController**                      | `api/v1/admin/knowledge/documents`                             | 5    | JWT + API key | scope `admin:knowledge:manage` jwt: manage:KnowledgeDocument (chunks → read)             | Qdrant cleanup fail-closed on delete.                      |
| **WorkflowTestFixtureController**            | `api/v1/admin/workflow-test-fixtures`                          | 5    | JWT + API key | scope `admin:workflow-test-fixture:manage` jwt: manage:WorkflowTestFixture               | —                                                          |
| **NotificationController**                   | `api/v1/admin/notifications`                                   | 4    | JWT + API key | scope `admin:notification:manage` jwt: manage:Notification                               | No create route.                                           |
| **UserDepartmentsController**                | `api/v1/admin/users`                                           | 4    | JWT + API key | scope `admin:user:write` jwt: manage:User                                                | :id/departments assign/unassign.                           |
| **WorkflowSandboxRunController**             | `api/v1/admin/workflow-definitions/:definitionId/sandbox-runs` | 4    | JWT + API key | scope `admin:workflow-definition:manage` jwt: per-method WorkflowRun Can*                | Hand-rolled SSE + StreamScope workflow_run.                |
| **AdminConsultationController**              | `api/v1/admin/consultations`                                   | 3    | JWT + API key | scope `admin:consultation-admin:manage` jwt: manage:Consultation                         | Tenant-wide list/aggregate.                                |
| **AdminTranscriptionJobController**          | `api/v1/admin/audio/transcription-jobs`                        | 3    | JWT + API key | scope `admin:transcription-job:read` jwt: class manage:Tenant; handlers read:AsrPipeline | —                                                          |
| **AgentPromotionController**                 | `api/v1/admin/agent-promotions`                                | 3    | JWT + API key | scope `admin:agent-promotion:manage` jwt: manage:DepartmentAgent                         | POST requires manage in both tenants (service).            |
| **AgentTrajectoryController**                | `api/v1/admin/agent-trajectory`                                | 3    | JWT + API key | scope `admin:agent-trajectory:read` jwt: read:AgentTrajectory                            | —                                                          |
| **ConsentGrantController**                   | `api/v1/admin/consent-grants`                                  | 3    | JWT only      | **API key forbidden** jwt: manage:ConsentGrant                                           | Human-only consent admin. `@ForbidApiKey()`.               |
| **PipelinePolicyAdminController**            | `api/v1/admin/harness/pipeline-policy`                         | 3    | JWT + API key | scope `admin:pipeline-policy:manage` jwt: read/manage:PipelinePolicy                     | —                                                          |
| **StorageAccessKeyController**               | `api/v1/admin/tenants/storage/keys`                            | 3    | JWT + API key | scope `admin:storage-key:manage` jwt: class manage:Tenant; methods Can*:Storage          | —                                                          |
| **WorkflowRunController**                    | `api/v1/admin/workflow-runs`                                   | 3    | JWT + API key | scope `admin:workflow-run:read` jwt: read:WorkflowRun                                    | Working-tenant CLS required.                               |
| **NlpTaskInstructionsAdminController**       | `api/v1/admin/nlp-task-instructions`                           | 2    | JWT + API key | scope `admin:nlp-task-instructions:manage` jwt: read/manage:TenantNlpTaskInstructions    | No class @Authorize; per-handler CASL.                     |
| **TenantFrontendConfigAdminController**      | `api/v1/admin/tenant-frontend-config`                          | 2    | JWT + API key | scope `admin:tenant-frontend-config:manage` jwt: manage                                  | update:Tenant                                              |
| **AgenticAdminController**                   | `api/v1/admin/agentic`                                         | 1    | JWT + API key | scope `admin:agentic:manage` jwt: @Authorize() + manage:HarnessPolicy                    | GET instructions.                                          |
| **WorkflowNodeController**                   | `api/v1/admin/workflow-nodes`                                  | 1    | JWT + API key | scope `admin:workflow-node:read` jwt: read:WorkflowDefinition                            | Read-only registry.                                        |




### ENDUSER — clinician / self-service plane

Non-`/admin` planes reachable by ordinary authenticated users: consultations, own reports/styles/preferences, own tenant/billing/usage reads.

*26 controllers · 168 handlers* (TASK-759 moved `MonitoringController` and the `ApiHealthController` `/services` routes out of this plane — they were never end-user surfaces; the four public probes moved to PUBLIC)


| Controller                          | Prefix                             | APIs | Auth model    | Access scope                                                                                           | Notes                                                                                                |
| ----------------------------------- | ---------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **ConsultationController**          | `api/v1/consultations`             | 51   | JWT + API key | scope `consultation:session:write (read/report overrides)` jwt: @Authorize(); some create:Consultation | Largest surface. 5 @Sse() streams + StreamScope. Consent on history/prime/recording.                 |
| **TranscriptionJobController**      | `api/v1/audio/transcription-jobs`  | 20   | JWT + API key | scope `stt:transcription:write` jwt: @Authorize()                                                      | 1 @Sse() job stream. Stream session CRUD + TenantOwnedResource.                                      |
| **DnaWritingStyleController**       | `api/v1/dna-writing-styles`        | 14   | JWT only      | **API key forbidden** (@ForbidApiKey) jwt: @Authorize(); owner/doctor checks in service                | SSE job stream has no @StreamScope — ticket will 401.                                                |
| **StorageController**               | `api/v1/storage`                   | 10   | JWT + API key | scope `media:file:write` jwt: per-verb Storage                                                         | MinIO/S3. TenantOwnedResource on named buckets.                                                      |
| **AuthController**                  | `api/v1/auth`                      | 7    | Mixed         | **API key forbidden** jwt: class @ForbidApiKey; login+refresh @Public                                  | Public: POST login, POST refresh. JWT: logout, me, impersonate, stream-ticket, revoke-impersonation. |
| **TextProxyController**             | `api/v1/text`                      | 7    | JWT + API key | scope `consultation:report:write` jwt: @Authorize()                                                    | Hand-rolled SSE on GET tasks/:taskId/stream (StreamScope text_task).                                 |
| **AiInferenceController**           | `api/v1/ai`                        | 5    | JWT + API key      | **API key `ai:inference:write`** jwt: @Authorize()                                                                | Guardrail + NLP proxy.                                                                               |
| **PromptTemplateController**        | `api/v1/prompt-templates`          | 5    | JWT + API key      | **API key `prompt:template:read`** jwt: read:PromptTemplate (writes owner-gated in service)                         | Clinician plane — AUTH-NOTE: declared read, ownership in service.                                    |
| **VoiceProfileController**          | `api/v1/voice-profile`             | 5    | JWT only      | **API key forbidden** jwt: per-verb UserVoiceProfile                                                   | TenantOwnedResource on mutate/delete.                                                                |
| **WorkflowsController**             | `api/v1/workflows`                 | 5    | JWT + API key | scope `workflow:definition:read / workflow:run:read                                                    | write` jwt: per-route WorkflowDefinition / WorkflowRun                                               |
| **AudioPipelinePublicController**   | `api/v1/audio/pipelines`           | 3    | JWT + API key      | **API key `stt:model:read`** jwt: @Authorize()                                                                | Read-only catalog for clinicians.                                                                    |
| **ChangelogController**             | `api/v1/changelog`                 | 3    | JWT + API key      | **API key `platform:changelog:read`** jwt: @Authorize() (any authenticated user)                                       | Reader plane.                                                                                        |
| **ConsultationJobController**       | `api/v1/consultations/jobs`        | 3    | JWT + API key | scope `consultation:session:read` jwt: @Authorize()                                                    | 1 SSE + TenantOwnedResource.                                                                         |
| **MyBillingController**             | `api/v1/billing`                   | 3    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                                                 | CLS tenant only. 404-over-403 on foreign invoice.                                                    |
| **MyTenantController**              | `api/v1/tenant`                    | 3    | JWT + API key      | **API key `tenant:profile:read`** jwt: @Authorize(); PATCH update:Tenant                                           | —                                                                                                    |
| **PermissionCheckController**       | `api/v1/rbac/check`                | 3    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize(); other-user checks need manage:User                            | —                                                                                                    |
| **SttCompatController**             | `api/stt (prefix excluded)`        | 3    | JWT + API key | scope `stt:stream:write` jwt: @Authorize()                                                             | Live paths: POST /api/stt/{start_session,switch,stop_session}.                                       |
| **MyUsageController**               | `api/v1/usage`                     | 2    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                                                 | No tenantId override.                                                                                |
| **SpeechProxyController**           | `api/v1/speech`                    | 2    | JWT + API key | scope `tts:speech:write` jwt: @Authorize()                                                             | Synthesize may be SSE or audio bytes.                                                                |
| **TextCompatController**            | `api/smr/api/v1 (prefix excluded)` | 2    | JWT + API key | scope `consultation:report:write` jwt: @Authorize()                                                    | POST /api/smr/api/v1/{summary/sync,presummary}. SSE if body.stream===true.                           |
| **UserPreferencesController**       | `api/v1/user/me/preferences`       | 2    | JWT + API key | scope `user:preferences:write` jwt: @Authorize()                                                       | Self CLS user.                                                                                       |
| **UserSettingsController**          | `api/v1/user/me/settings`          | 2    | JWT + API key      | **API key `user:settings:read`** jwt: @Authorize()                                                                | —                                                                                                    |
| **MyEntitlementsController**        | `api/v1/entitlements`              | 1    | JWT + API key      | **API key `tenant:account:read`** jwt: read:Tenant                                                                 | —                                                                                                    |
| **MyTenantContextSchemaController** | `api/v1/tenant/me/context-schema`  | 1    | JWT + API key      | **API key `tenant:context-schema:read`** jwt: @Authorize()                                                                | Same file as ConsultationContextSchemaAdminController.                                               |
| **UserDepartmentsMeController**     | `api/v1/user/me/departments`       | 1    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize()                                                                | —                                                                                                    |
| **UserRolesController**             | `api/v1/users`                     | 1    | JWT + API key      | **API key `user:profile:read`** jwt: @Authorize(); :id must equal caller                                         | —                                                                                                    |




### MACHINE — service token / worker (no human)

No user JWT. `/internal/*` uses `@Public()` + an `X-Service-Token` guard; `SttInternalController` is the exception on the API-key path; the three gateways run outside `APP_GUARD` entirely.

*8 controllers · 47 handlers*


| Controller                           | Prefix                             | APIs | Auth model    | Access scope                                                                                             | Notes                                                                               |
| ------------------------------------ | ---------------------------------- | ---- | ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **HarnessInternalController**        | `api/v1/internal/harness`          | 18   | Service token | **no key path** — X-Service-Token (HarnessServiceTokenGuard) jwt: skipped (@Public)                      | Harness worker callbacks. UnifiedAuth skipped.                                      |
| **SttInternalController**            | `api/v1/internal/stt`              | 10   | JWT + API key | scope `internal:stt:worker (X-Internal-Service-Key)` jwt: @Authorize() — worker rejects JWT in handler   | Exception to /internal Public+token pattern. Tenant pin needs platform key.         |
| **SttWsGateway**                     | `/ws/stt/stream (no api/v1)`       | 6    | Stream ticket | **no key path** — `?ticket=` scoped `stt_session:<id>` jwt: n/a — Nest APP_GUARD does not run            | Raw ws. Origin check + Redis tenant binding. Binary + JSON audio/stop/resume/close. |
| **TtsWsGateway**                     | `/ws/tts/stream (no api/v1)`       | 5    | Stream ticket | **no key path** — `?ticket=` scoped `tts_session:<id>` jwt: n/a — APP_GUARD does not run                 | No Redis tenant-binding cross-check. Quota close 4429.                              |
| **SttCompatGateway**                 | `/stt (no api/v1)`                 | 4    | API key (WS)  | scope `WS headers apikey/api-key/x-api-key/x-internal-service-key, or query apiKey/api-key/key` jwt: n/a | Legacy v1. Session tenant must match key tenant.                                    |
| **ServiceReleaseInternalController** | `api/v1/internal/service-releases` | 2    | Service token | **no key path** — X-Service-Token (any known service secret) jwt: skipped (@Public)                      | —                                                                                   |
| **ConsentInternalController**        | `api/v1/internal/consent`          | 1    | Service token | **no key path** — X-Service-Token (HarnessServiceTokenGuard) jwt: skipped (@Public)                      | POST assert.                                                                        |
| **EffectiveConfigController**        | `api/v1/internal/effective-config` | 1    | Service token | **no key path** — X-Service-Token (InternalServiceTokenGuard) jwt: skipped (@Public)                     | —                                                                                   |




### PUBLIC — unauthenticated

Genuinely open. All throttled; self-signup 404s when the flag is off.

*5 controllers · 13 handlers* (+`ApiHealthController` 4, TASK-759)


| Controller                   | Prefix                        | APIs | Auth model | Access scope                        | Notes                                      |
| ---------------------------- | ----------------------------- | ---- | ---------- | ----------------------------------- | ------------------------------------------ |
| **AuthSsoController**        | `api/v1/auth/sso`             | 5    | Public     | **no key path** jwt: none (@Public) | OIDC + SAML start/callback/ACS. Throttled. |
| **RegisterController**       | `api/v1/auth`                 | 2    | Public     | **no key path** jwt: none           | 404 if self-signup flag off. Throttled.    |
| **ForgotPasswordController** | `api/v1/auth`                 | 1    | Public     | **no key path** jwt: none           | Throttled 5/min.                           |
| **PasswordResetController**  | `api/v1/users/password-reset` | 1    | Public     | **no key path** jwt: none           | POST complete. Token in body.              |
| **ApiHealthController**      | `api/v1/health`               | 4    | Public     | **no key path** jwt: none           | k3s liveness/readiness/startup + detailed. Moved here by TASK-759 once its two CASL-gated /services routes were split off. Throttled 30/min. |



---

## View C — v1 compat surface (SDK-compat / API-compat)

Six surfaces are **frozen v1 wire contracts**: five HTTP paths listed in `main.ts`'s `setGlobalPrefix` `exclude` array plus one WebSocket gateway. The exclusion exists so `@Controller('api/smr/api/v1')` yields the *literal* legacy URL instead of `/api/v1/api/smr/api/v1/…`.

**Status: kept deliberately, no sunset.** Owner decision 704 (`docs/architecture/agentic-workflow-platform/owner-decisions-2026-08-17.md:76`) — *"Do NOT touch legacy pre-summarization and summarization — they are STANDALONE features, kept deliberately. They serve SDK-compat and API-compat consumers."* TASK-740 renamed `smr`→`text` throughout the internal identifiers but carved out these wire routes as a published API contract. No removal date or ticket exists in the accessible docs.

| Surface                  | Method + path                       | Auth / scope                                                                                                                                                               | Modern equivalent                                                                                    | Consumers                                                                              |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **TextCompatController** | `POST /api/smr/api/v1/summary/sync` | `@Authorize()` + `consultation:report:write`                                                                                                                               | `POST /api/v1/consultations/:id/summary` (persisted) or `POST /api/v1/text/generate` (raw)           | `@arcaai/vox-node`, `@arcaai/vox/compat`, compat-playground, quick-compat-app, example |
| **TextCompatController** | `POST /api/smr/api/v1/presummary`   | `@Authorize()` + `consultation:report:write`                                                                                                                               | `POST /api/v1/consultations/:id/summary/pre-summary`                                                 | same as above                                                                          |
| **SttCompatController**  | `POST /api/stt/switch`              | `@Authorize()` + class `stt:stream:write`                                                                                                                                  | `.../stream/session/:id/switch-to-fallback` \| `switch-to-primary`                                   | `@arcaai/vox/compat` **only when `setCompatSwitchEnabled(true)`**                      |
| **SttCompatController**  | `POST /api/stt/start_session`       | `@Authorize()` + class `stt:stream:write`                                                                                                                                  | `POST /api/v1/audio/transcription-jobs/stream/session`                                               | **`apps/example` raw `fetch()` only** — no SDK caller                                  |
| **SttCompatController**  | `POST /api/stt/stop_session`        | `@Authorize()` + class `stt:stream:write`; `multipart/form-data`                                                                                                           | `DELETE /api/v1/audio/transcription-jobs/stream/session/:sessionId`                                  | **none in-repo**                                                                       |
| **SttCompatGateway**     | `ws /stt`                           | API key on handshake (`apikey`/`api-key`/`x-api-key`/`x-internal-service-key`, or `?apiKey=`/`?api-key=`/`?key=`); session tenant must equal key tenant, else close `4401` | `SttWsGateway` `ws /ws/stt/stream` — single-use `?ticket=` (`stt_session:<id>`) + CSWSH origin check | **none in-repo**                                                                       |

### Consumer matrix

| Consumer                           | Kind    | summary/sync | presummary |  switch  | start_session | stop_session | ws `/stt` |
| ---------------------------------- | ------- | :----------: | :--------: | :------: | :-----------: | :----------: | :-------: |
| `@arcaai/vox-node` (server SDK)    | product |      ✅       |     ✅      |    —     |       —       |      —       |     —     |
| `@arcaai/vox/compat` (browser SDK) | product |      ✅       |     ✅      | ⚙️ opt-in |       —       |      —       |     —     |
| `apps/compat-playground` (:5177)   | demo    |   via SDK    |  via SDK   | via SDK  |       —       |      —       |     —     |
| `apps/quick-compat-app` (:5180)    | demo    |   via SDK    |  via SDK   | via SDK  |       —       |      —       |     —     |
| `apps/example`                     | demo    |   via SDK    |  via SDK   |    —     | ✅ raw `fetch` |      —       |     —     |
| e2e specs                          | test    |      ✅       |     ✅      |    ✅     |       —       |      —       |     —     |

⚙️ = reached only when `StreamingSessionManager.setCompatSwitchEnabled(true)`; defaults to `false` so native SDK consumers never hit it.

### Things worth knowing

- **The exempt-path list is duplicated in two places.** `apps/api/src/main.ts` owns it; `packages/vox-node/src/core/url.ts:26` mirrors it as a literal `PREFIX_EXEMPT_PATHS` set. vox-node lists only the **two** SMR paths — correct, because it has no STT/audio surface at all (`HopeClient` exposes summarization/consultations/jobs only). The file warns that generalizing to "everything under `api/smr/`" would be wrong. Any change to the exclusion array must be made in both.
- **`stop_session` and the legacy `/stt` gateway have zero in-repo callers** — no SDK path, no demo, no e2e spec (unit tests only). They exist purely for external v1 clients.
- **`@arcaai/vox/compat` never uses `start_session` or the legacy WS gateway.** Compat session creation collapses onto the native `useArcaSession().open()`, and streaming goes over `/ws/stt/stream`. Only `apps/example/src/compat-consultation.tsx:125` demonstrates the genuinely-non-SDK v1 client path.
- **`use_enhanced_format: true` is exempt from the v1 template path** — it is an explicit request for the frozen `EnhancedMedicalSummary` wire contract (`text-compat.controller.ts:358-364`).
- **TASK-742 (2026-08-18) closed a P0 fail-open here:** `/api/stt` was reachable by any API key with no scope check because it was not in the audited 14-route list. It now carries the class-level `stt:stream:write`. That was security hardening, not deprecation.
