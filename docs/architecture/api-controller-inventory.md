# apps/api controller inventory

| | | | |
|---|---|---|---|
| **Owner** | Platform / Architecture | **Last verified** | 2026-08-18 |
| **Scope** | NestJS HTTP controllers and WebSocket gateways in `apps/api` | **Handlers** | 605 HTTP/SSE + 3 gateways |

Catalog of the NestJS API gateway (`apps/api`, port 8868): every live HTTP controller class, every HTTP/SSE handler, and the three raw WebSocket gateways. Companion to [overview.md](./overview.md). This is an architecture inventory, not a ticket README.

**Sources (2026-08-18):** decorator recount of `apps/api/src/**/*.controller.ts` (`@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` / `@Sse` / `@ApiEndpoint`, clustered per handler so `@Get`+`@Sse` counts as one); merged canvas `api-controller-inventory.canvas.tsx` (auth classification and notes); per-endpoint catalogs from the controller/gateway exploration transcripts. File wins if a transcript total disagrees — `SttInternalController` is **10** handlers.

Global HTTP prefix is `api/v1` (`apps/api/src/main.ts`) except the prefix-excluded surfaces listed in [Completeness](#7-completeness). WebSocket paths are **not** under `api/v1`.

Document layout: (1) this intro, (2) how to read auth, (3) headline stats, (4) summary table, (5) per-controller HTTP catalog, (6) WebSocket gateways, (7) SSE inventory, (8) completeness.

---

## 1. How to read auth

Routes are **authenticated by default**. The global `APP_GUARD` `UnifiedAuthGuard` denies anything that is not `@Public()`. There is no `SkipAuth` decorator. Nest metadata is **method over class** (`Reflector.getAllAndOverride([handler, class])`): the same key on the method **replaces** the class value; it does not merge.

| Decorator / signal | Meaning for that HTTP route |
|---|---|
| `@Public()` | `UnifiedAuthGuard` returns immediately. Unauthenticated **unless** there is also `@UseGuards(…TokenGuard)`. |
| `@Authorize` / `@CanXxx` and **not** `@Public()` | JWT (or stream ticket) required. CASL checked if the permission list is non-empty. Empty `@Authorize()` = any authenticated JWT user. |
| `@RequiredScopes('…')` | API keys **may** call this route if they hold a matching scope **and** the key’s bound user passes the same CASL check. |
| `@ForbidApiKey()` | API keys **never** (even `*`). JWT/ticket still work. |
| Neither `@RequiredScopes` nor `@ForbidApiKey` nor `@Public()` | Boot failure (TASK-742). At runtime an API key would 403 with `"This route does not accept API-key authentication"`. |
| `// AUTH-NOTE:` | Decorator **understates** the real gate (super-admin-only, owner-scoped write, SYSTEM vs tenant). Read the service. |
| No `@Roles()` | JWT `roles` feed CASL `PolicyEngine`. Authorization is `@Authorize` / `@CanXxx`. |

**Pipeline (declaration order in `app.module.ts`):** `TieredThrottlerGuard` → `ClsGuard` → **`UnifiedAuthGuard`** → `PatientConsentGuard` → `TenantOwnedResourceSseGuard` → `OriginTenantBindingGuard` → `RequiresIfMatchGuard`.

**API-key vs JWT:** If any API-key header is present (`apikey` / `api-key` / `x-api-key` / `x-internal-service-key`), JWT is **never** tried. A bad key is 401, not a fallthrough to Bearer. Query `?apiKey=` is off by default (`API_KEY_ALLOW_QUERY_PARAM`).

**Internal services:** `/internal/*` except the STT worker is `@Public()` plus an `X-Service-Token` guard (`InternalServiceTokenGuard`, `HarnessServiceTokenGuard`, or `ServiceReleaseTokenGuard`). `SttInternalController` (`/internal/stt`) stays on the API-key path with reserved scope `internal:stt:worker` (`X-Internal-Service-Key`). Handlers reject JWT.

**SSE:** Still HTTP — Bearer JWT, or `?token=` JWT, or `?ticket=` when `@StreamScope` is present. Tickets are minted at `POST /api/v1/auth/stream-ticket` (JWT, `@ForbidApiKey()`).

**WebSockets:** Nest `APP_GUARD` does **not** run. STT/TTS stream gateways use single-use `?ticket=` (`stt_session:<id>` / `tts_session:<id>`). The STT compat gateway uses API keys on the WebSocket handshake.

**Human-only (not API-key reachable):** class `@ForbidApiKey()`. Includes `ConsentGrantController` (JWT-only consent admin) even though it sits under `/admin/consent-grants`.

---

## 2. Headline stats

| Stat | Verified count |
|---|---|
| HTTP `@Controller` classes | **104** (all registered in modules) |
| Live `*.controller.ts` files | **102** (two files hold two classes) |
| Unused abstract helper | `BaseProxyController` (`src/shared/base-proxy.controller.ts`) — no `@Controller()`, no routes |
| HTTP + SSE handlers | **605** |
| WebSocket gateways | **3** (`APP_GUARD` does not run) |
| Vendored HTTP | `PrometheusController` `GET /metrics` (patched `@Public()`) |

### Handler auth split (605 HTTP/SSE)

Mixed controllers (`AuthController`, `ApiHealthController`) are split into public vs JWT-only at the handler.

| Auth | Controllers | Handlers |
|---|---:|---:|
| JWT + API key (`@RequiredScopes`) | 76 | 501 |
| JWT only (`@ForbidApiKey` or no key path), including mixed JWT methods | 18 jwt-only classes + mixed JWT methods | 67 |
| Public (`@Public()`), including mixed public methods | 4 public classes + mixed public methods | 15 |
| Service token (`@Public()` + `X-Service-Token`) | 4 | 22 |
| **Total** | **104** | **605** |

API-key-reachable handlers (`apikeyCount` after correcting `ConsentGrantController` to 0): **501**.

Largest HTTP surfaces: `ConsultationController` 51, `HarnessAdminController` 26, `UserController` 21, `TranscriptionJobController` 20, `HarnessInternalController` 18.

---

## 3. Summary table

One row per HTTP controller and WebSocket gateway. Sorted by API count descending, then name. Prefixes are live URL prefixes (`api/v1/…` unless noted). Prometheus is vendored and listed in [Completeness](#7-completeness), not here.

| Controller | Prefix | APIs | Auth model | API key | JWT / other | Notes |
|---|---|---:|---|---|---|---|
| ConsultationController | `api/v1/consultations` | 51 | JWT + API key | consultation:session:write (read/report overrides) | @Authorize(); some create:Consultation | Largest surface. 5 @Sse() streams + StreamScope. Consent on history/prime/recording. |
| HarnessAdminController | `api/v1/admin/harness` | 26 | JWT + API key | admin:harness:manage | per-method HarnessPolicy / Eval / Workflow / Audit | Policy, golden sets, Temporal workflow ops, live sessions. |
| UserController | `api/v1/admin/users` | 21 | JWT + API key | admin:user:write | manage:User (assign-role → UserRoleAssignment) | Shares prefix with UserDepartments + AdminImpersonation. |
| TranscriptionJobController | `api/v1/audio/transcription-jobs` | 20 | JWT + API key | stt:transcription:write | @Authorize() | 1 @Sse() job stream. Stream session CRUD + TenantOwnedResource. |
| HarnessInternalController | `api/v1/internal/harness` | 18 | Service token | n/a — X-Service-Token (HarnessServiceTokenGuard) | skipped (@Public) | Harness worker callbacks. UnifiedAuth skipped. |
| PromptManagementController | `api/v1/admin/prompt-templates` | 16 | JWT + API key | admin:prompt-template:manage | manage:PromptTemplate (method Can* overrides) | Approve is SYSTEM-row SUPER_ADMIN in service. Assign-department uses manage:Department. |
| TenantController | `api/v1/admin/tenants` | 15 | JWT + API key | admin:tenant:write | manage\|update:Tenant (lifecycle = manage) | Shares prefix with provision + pipeline-resync. |
| AudioPipelineController | `api/v1/admin/audio/pipelines` | 14 | JWT + API key | admin:audio-pipeline:manage | manage:AsrPipeline | YAML validate, clone, tenant assign, versions. |
| DnaWritingStyleController | `api/v1/dna-writing-styles` | 14 | JWT only | forbidden (@ForbidApiKey) | @Authorize(); owner/doctor checks in service | SSE job stream has no @StreamScope — ticket will 401. |
| QueueAdminController | `api/v1/admin/queues` | 12 | JWT + API key | admin:queue:manage | manage:all | SUPER_ADMIN BullMQ ops. |
| TenantBucketController | `api/v1/admin/tenants/storage/buckets` | 12 | JWT + API key | admin:tenant-storage:manage | class manage:Tenant; methods Can*:Storage | TenantOwnedResource on named buckets. |
| EntitlementsAdminController | `api/v1/admin/entitlements` | 11 | JWT + API key | admin:entitlement:manage | manage:all | Plans, tenant overrides, trial expiry. |
| DepartmentController | `api/v1/admin/departments` | 10 | JWT + API key | admin:department:manage | manage:Department | Tree + users + prompt-config OCC. |
| RolesController | `api/v1/admin/rbac/roles` | 10 | JWT + API key | admin:role:write | manage:Role (reads CanAny read\|manage) | Break-glass on deletes. |
| StorageController | `api/v1/storage` | 10 | JWT + API key | media:file:write | per-verb Storage | MinIO/S3. TenantOwnedResource on named buckets. |
| SttInternalController | `api/v1/internal/stt` | 10 | JWT + API key | internal:stt:worker (X-Internal-Service-Key) | @Authorize() — worker rejects JWT in handler | Exception to /internal Public+token pattern. Tenant pin needs platform key. |
| ApiKeyController | `api/v1/admin/api-keys` | 9 | JWT + API key | admin:apikey:write | manage:ApiKey + per-verb Can* | Create/rotate/revoke plus scopes catalog. |
| DepartmentAgentController | `api/v1/admin/department-agents` | 9 | JWT + API key | admin:department-agent:manage | manage:DepartmentAgent | Shares prefix with resync controller. |
| ConsultationContextSchemaAdminController | `api/v1/admin/consultation-context-schemas` | 8 | JWT + API key | admin:consultation-context-schema:manage | manage:ConsultationContextSchema | Same file as MyTenantContextSchemaController. |
| DnaWritingStyleAdminController | `api/v1/admin/dna-writing-styles` | 8 | JWT + API key | admin:dna-writing-style:manage | manage:DnaWritingStyleReport | SSE job stream with StreamScope dna_job. |
| GlobalSettingController | `api/v1/admin/settings` | 8 | JWT + API key | admin:settings:manage | manage:GlobalSetting (reveal/rotate → manage:all) | Shares prefix with catalog + registry-write. |
| TenantIdpConfigAdminController | `api/v1/admin/tenant-idp-config` | 8 | JWT + API key | admin:tenant-idp-config:manage | read/manage:TenantIdentityProvider | Test + directory sync. |
| TenantSttConfigAdminController | `api/v1/admin/stt-config` | 8 | JWT + API key | admin:tenant-stt-config:manage | read/manage:TenantSttConfig | Effective + row + credentials test. |
| WorkflowDefinitionController | `api/v1/admin/workflow-definitions` | 8 | JWT + API key | admin:workflow-definition:manage | manage:WorkflowDefinition | Validate + publish. |
| AiModelAdminController | `api/v1/admin/ai-models` | 7 | JWT + API key | admin:ai-model:manage | manage:all | Shares prefix with discovery controller. |
| AuthController | `api/v1/auth` | 7 | Mixed | forbidden | class @ForbidApiKey; login+refresh @Public | Public: POST login, POST refresh. JWT: logout, me, impersonate, stream-ticket, revoke-impersonation. |
| BillingAdminController | `api/v1/admin/billing/invoices` | 7 | JWT + API key | admin:billing:manage | manage:BillingInvoice | Mutations SUPER_ADMIN in service. |
| PoliciesController | `api/v1/admin/rbac/policies` | 7 | JWT + API key | admin:rbac-policy:write | manage:Policy (GETs CanAny read\|manage) | Break-glass on protected deletes. |
| TenantTtsConfigAdminController | `api/v1/admin/tts-config` | 7 | JWT + API key | admin:tenant-tts-config:manage | read/manage:TenantTtsConfig | Catalog + credentials. |
| TextProxyController | `api/v1/text` | 7 | JWT + API key | consultation:report:write | @Authorize() | Hand-rolled SSE on GET tasks/:taskId/stream (StreamScope text_task). |
| WebhookController | `api/v1/admin/webhooks` | 7 | JWT + API key | webhook:event:write | manage:Webhook (deliveries read:WebhookRunHistory) | Rotate-secret OCC. |
| ApiHealthController | `api/v1/health` | 6 | Mixed | forbidden | class @ForbidApiKey; services routes CanAny manage:all \| read:TenantTelemetry | Public: /, /live, /ready, /startup. JWT: /services, /services/:key. |
| AuditLogController | `api/v1/admin/audit-logs` | 6 | JWT + API key | admin:audit:read | read:AuditLog | Non-SUPER_ADMIN needs tenant context. |
| ResourceSubscriptionController | `api/v1/admin/resource-subscriptions` | 6 | JWT + API key | admin:resource-subscription:manage | manage:ResourceSubscription | Tenant-scoped in service. |
| SttWsGateway | `/ws/stt/stream (no api/v1)` | 6 | Stream ticket | no — ?ticket= scoped stt_session:<id> | n/a — Nest APP_GUARD does not run | Raw ws. Origin check + Redis tenant binding. Binary + JSON audio/stop/resume/close. |
| TenantAllowedOriginController | `api/v1/admin/allowed-origins` | 6 | JWT + API key | admin:allowed-origin:manage | manage:TenantAllowedOrigin | Wildcard origins SUPER_ADMIN in service. |
| TenantStorageConfigAdminController | `api/v1/admin/tenants/storage/config` | 6 | JWT + API key | admin:tenant-storage:manage | manage\|update:Tenant; methods Can*:Storage | Platform default routes SUPER_ADMIN in service. |
| AiInferenceController | `api/v1/ai` | 5 | JWT only | forbidden | @Authorize() | Guardrail + NLP proxy. |
| AiRuntimeProfileController | `api/v1/admin/ai-runtime-profiles` | 5 | JWT + API key | admin:ai-runtime-profile:manage | manage:all | SUPER_ADMIN / SYSTEM rows. |
| AuthSsoController | `api/v1/auth/sso` | 5 | Public | n/a | none (@Public) | OIDC + SAML start/callback/ACS. Throttled. |
| KnowledgeController | `api/v1/admin/knowledge/documents` | 5 | JWT + API key | admin:knowledge:manage | manage:KnowledgeDocument (chunks → read) | Qdrant cleanup fail-closed on delete. |
| McpAdminController | `api/v1/admin/mcp-servers` | 5 | JWT + API key | admin:mcp-server:manage | read/manage:McpServer | Writes SUPER_ADMIN-only in service. |
| PromptTemplateController | `api/v1/prompt-templates` | 5 | JWT only | forbidden | read:PromptTemplate (writes owner-gated in service) | Clinician plane — AUTH-NOTE: declared read, ownership in service. |
| SchedulerAdminController | `api/v1/admin/schedulers` | 5 | JWT + API key | admin:scheduler:manage | manage:all | Pause/resume/cron/toggle. |
| TtsWsGateway | `/ws/tts/stream (no api/v1)` | 5 | Fail-closed Origin check, then stream ticket | no — ?ticket= scoped tts_session:<id> | n/a — APP_GUARD does not run | No Redis tenant-binding cross-check — no server-side TTS session resource exists to bind (TASK-755). Quota close 4429. |
| VoiceProfileController | `api/v1/voice-profile` | 5 | JWT only | forbidden | per-verb UserVoiceProfile | TenantOwnedResource on mutate/delete. |
| WorkflowTestFixtureController | `api/v1/admin/workflow-test-fixtures` | 5 | JWT + API key | admin:workflow-test-fixture:manage | manage:WorkflowTestFixture |  |
| WorkflowsController | `api/v1/workflows` | 5 | JWT + API key | workflow:definition:read / workflow:run:read\|write | per-route WorkflowDefinition / WorkflowRun | Hand-rolled SSE on run stream. Heavy throttle on invoke. |
| AdminUsageController | `api/v1/admin/usage` | 4 | JWT + API key | admin:usage:manage | manage:UsageAnalytics | top-tenants SUPER_ADMIN in service. |
| AiProviderConnectionController | `api/v1/admin/ai-providers` | 4 | JWT + API key | admin:ai-provider:manage | read/manage:GlobalSetting | Legacy LLM alias (service=llm). |
| AiTaskDefaultAdminController | `api/v1/admin/ai-task-defaults` | 4 | JWT + API key | admin:ai-task-default:manage | read/manage:AiTaskDefault | Some keys SUPER_ADMIN in service. |
| MonitoringController | `api/v1/monitoring` | 4 | JWT only | forbidden | CanAny manage:all \| read:TenantTelemetry | Not under /admin. Throttle 300/60s. |
| NotificationController | `api/v1/admin/notifications` | 4 | JWT + API key | admin:notification:manage | manage:Notification | No create route. |
| ProviderConnectionController | `api/v1/admin/providers` | 4 | JWT + API key | admin:ai-provider:manage | read/manage:GlobalSetting | Same file as AiProviderConnectionController. |
| RateLimitAdminController | `api/v1/admin/rate-limit` | 4 | JWT + API key | admin:rate-limit:manage | manage:all | SUPER_ADMIN policy editor. |
| SttCompatGateway | `/stt (no api/v1)` | 4 | API key (WS) | WS headers apikey/api-key/x-api-key/x-internal-service-key, or query apiKey/api-key/key | n/a | Legacy v1. Session tenant must match key tenant. |
| UserDepartmentsController | `api/v1/admin/users` | 4 | JWT + API key | admin:user:write | manage:User | :id/departments assign/unassign. |
| WorkflowSandboxRunController | `api/v1/admin/workflow-definitions/:definitionId/sandbox-runs` | 4 | JWT + API key | admin:workflow-definition:manage | per-method WorkflowRun Can* | Hand-rolled SSE + StreamScope workflow_run. |
| AdminConsultationController | `api/v1/admin/consultations` | 3 | JWT + API key | admin:consultation-admin:manage | manage:Consultation | Tenant-wide list/aggregate. |
| AdminReconciliationController | `api/v1/admin/usage/reconciliation` | 3 | JWT + API key | admin:usage:manage | manage:UsageAnalytics |  |
| AdminTranscriptionJobController | `api/v1/admin/audio/transcription-jobs` | 3 | JWT + API key | admin:transcription-job:read | class manage:Tenant; handlers read:AsrPipeline |  |
| AgentPromotionController | `api/v1/admin/agent-promotions` | 3 | JWT + API key | admin:agent-promotion:manage | manage:DepartmentAgent | POST requires manage in both tenants (service). |
| AgentTrajectoryController | `api/v1/admin/agent-trajectory` | 3 | JWT + API key | admin:agent-trajectory:read | read:AgentTrajectory |  |
| AiServiceAdminController | `api/v1/admin/ai-services` | 3 | JWT + API key | admin:ai-service:manage | manage:all | Read-only guardrail/NLP status proxy. |
| AudioPipelinePublicController | `api/v1/audio/pipelines` | 3 | JWT only | forbidden | @Authorize() | Read-only catalog for clinicians. |
| ChangelogAdminController | `api/v1/admin/changelog` | 3 | JWT + API key | admin:changelog:manage | manage:ChangelogEntry | SUPER_ADMIN in service. |
| ChangelogController | `api/v1/changelog` | 3 | JWT only | forbidden | @Authorize() (any authenticated user) | Reader plane. |
| ConsentGrantController | `api/v1/admin/consent-grants` | 3 | JWT only | forbidden | manage:ConsentGrant | Human-only consent admin. `@ForbidApiKey()`. |
| ConsultationJobController | `api/v1/consultations/jobs` | 3 | JWT + API key | consultation:session:read | @Authorize() | 1 SSE + TenantOwnedResource. |
| MyBillingController | `api/v1/billing` | 3 | JWT only | forbidden | read:Tenant | CLS tenant only. 404-over-403 on foreign invoice. |
| MyTenantController | `api/v1/tenant` | 3 | JWT only | forbidden | @Authorize(); PATCH update:Tenant |  |
| PermissionCheckController | `api/v1/rbac/check` | 3 | JWT only | forbidden | @Authorize(); other-user checks need manage:User |  |
| PipelinePolicyAdminController | `api/v1/admin/harness/pipeline-policy` | 3 | JWT + API key | admin:pipeline-policy:manage | read/manage:PipelinePolicy |  |
| PlatformMetricsController | `api/v1/admin/platform` | 3 | JWT + API key | admin:platform-metrics:read | manage:PlatformMetrics | SUPER_ADMIN via manage:all. |
| RateCardAdminController | `api/v1/admin/billing/rate-card` | 3 | JWT + API key | admin:billing:manage | manage:AiPriceBook | Mutations SUPER_ADMIN in service. |
| ServiceReleaseAdminController | `api/v1/admin/service-releases` | 3 | JWT + API key | admin:service-release:manage | CanAny manage:all \| read:TenantTelemetry |  |
| StorageAccessKeyController | `api/v1/admin/tenants/storage/keys` | 3 | JWT + API key | admin:storage-key:manage | class manage:Tenant; methods Can*:Storage |  |
| SttCompatController | `api/stt (prefix excluded)` | 3 | JWT + API key | stt:stream:write | @Authorize() | Live paths: POST /api/stt/{start_session,switch,stop_session}. |
| WorkflowRunController | `api/v1/admin/workflow-runs` | 3 | JWT + API key | admin:workflow-run:read | read:WorkflowRun | Working-tenant CLS required. |
| AiModelDiscoveryController | `api/v1/admin/ai-models` | 2 | JWT + API key | admin:ai-model:manage | manage:all |  |
| MyUsageController | `api/v1/usage` | 2 | JWT only | forbidden | read:Tenant | No tenantId override. |
| NlpTaskInstructionsAdminController | `api/v1/admin/nlp-task-instructions` | 2 | JWT + API key | admin:nlp-task-instructions:manage | read/manage:TenantNlpTaskInstructions | No class @Authorize; per-handler CASL. |
| PrismaStudioController | `api/v1/admin/pstudio` | 2 | JWT + API key | admin:pstudio:manage | manage:PrismaStudio | HTML shell + BFF POST. Not public. |
| RegisterController | `api/v1/auth` | 2 | Public | n/a | none | 404 if self-signup flag off. Throttled. |
| ServiceReleaseInternalController | `api/v1/internal/service-releases` | 2 | Service token | n/a — X-Service-Token (any known service secret) | skipped (@Public) |  |
| SettingsCatalogController | `api/v1/admin/settings` | 2 | JWT + API key | admin:settings:manage | read:GlobalSetting |  |
| SettingsRegistryWriteController | `api/v1/admin/settings` | 2 | JWT + API key | admin:settings:manage | read/manage:GlobalSetting | PUT uses ExpectedVersion, not RequiresIfMatch. |
| SpeechProxyController | `api/v1/speech` | 2 | JWT + API key | tts:speech:write | @Authorize() | Synthesize may be SSE or audio bytes. |
| TenantFrontendConfigAdminController | `api/v1/admin/tenant-frontend-config` | 2 | JWT + API key | admin:tenant-frontend-config:manage | manage\|update:Tenant |  |
| TextCompatController | `api/smr/api/v1 (prefix excluded)` | 2 | JWT + API key | consultation:report:write | @Authorize() | POST /api/smr/api/v1/{summary/sync,presummary}. SSE if body.stream===true. |
| UserPreferencesController | `api/v1/user/me/preferences` | 2 | JWT + API key | user:preferences:write | @Authorize() | Self CLS user. |
| UserSettingsController | `api/v1/user/me/settings` | 2 | JWT only | forbidden | @Authorize() |  |
| AdminImpersonationController | `api/v1/admin/users` | 1 | JWT only | forbidden | manage:all | SUPER_ADMIN impersonation. Throttled. |
| AgenticAdminController | `api/v1/admin/agentic` | 1 | JWT + API key | admin:agentic:manage | @Authorize() + manage:HarnessPolicy | GET instructions. |
| ConsentInternalController | `api/v1/internal/consent` | 1 | Service token | n/a — X-Service-Token (HarnessServiceTokenGuard) | skipped (@Public) | POST assert. |
| DepartmentAgentResyncController | `api/v1/admin/department-agents` | 1 | JWT + API key | admin:department-agent:manage | manage:Tenant | SUPER_ADMIN resync. |
| EffectiveConfigController | `api/v1/internal/effective-config` | 1 | Service token | n/a — X-Service-Token (InternalServiceTokenGuard) | skipped (@Public) |  |
| ForgotPasswordController | `api/v1/auth` | 1 | Public | n/a | none | Throttled 5/min. |
| MyEntitlementsController | `api/v1/entitlements` | 1 | JWT only | forbidden | read:Tenant |  |
| MyTenantContextSchemaController | `api/v1/tenant/me/context-schema` | 1 | JWT only | forbidden | @Authorize() | Same file as ConsultationContextSchemaAdminController. |
| PasswordResetController | `api/v1/users/password-reset` | 1 | Public | n/a | none | POST complete. Token in body. |
| PrismaStudioStatusController | `api/v1/admin/pstudio/status` | 1 | JWT + API key | admin:pstudio:manage | manage:PrismaStudio |  |
| TenantPipelineResyncController | `api/v1/admin/tenants` | 1 | JWT + API key | admin:tenant:write | manage:Tenant | SUPER_ADMIN. |
| TenantProvisionController | `api/v1/admin/tenants` | 1 | JWT + API key | admin:tenant:write | manage:Tenant | SUPER_ADMIN. |
| UserDepartmentsMeController | `api/v1/user/me/departments` | 1 | JWT only | forbidden | @Authorize() |  |
| UserRolesController | `api/v1/users` | 1 | JWT only | forbidden | @Authorize(); :id must equal caller |  |
| WorkflowNodeController | `api/v1/admin/workflow-nodes` | 1 | JWT + API key | admin:workflow-node:read | read:WorkflowDefinition | Read-only registry. |

*HTTP rows in this table: 104; API-count sum: 605. Gateway rows: 3.*

---

## 4. Per-controller HTTP catalog

Every live HTTP `@Controller` class. Paths include `/api/v1` except prefix-excluded compat routes. Endpoint lines are `METHOD /full/path — auth — apikey — extras`.

### ConsultationController

- **File:** `src/modules/consultation/consultation.controller.ts`
- **Prefix:** `consultations` → `api/v1/consultations`
- **api_count:** 51
- **Auth model:** JWT + API key
- **API key:** `consultation:session:write (read/report overrides)`
- **JWT / other:** @Authorize(); some create:Consultation
- **Notes:** Largest surface. 5 @Sse() streams + StreamScope. Consent on history/prime/recording.

- `POST /api/v1/consultations/open` — jwt `@Authorize([create,Consultation])` — apikey yes session:write — `open`
- `GET /api/v1/consultations/:id` — jwt — apikey **override** `consultation:session:read` — `getById`
- `GET /api/v1/consultations` — jwt — apikey session:write — `list`
- `GET /api/v1/consultations/patient/:patientId/history` — jwt — apikey session:write — `@RequiresConsent(HISTORY_RETRIEVAL)` — `getPatientHistory`
- `GET /api/v1/consultations/patient/:patientId/date/:date` — jwt — apikey session:write — consent HISTORY_RETRIEVAL — `getByPatientAndDate`
- `GET /api/v1/consultations/:id/chain` — jwt — apikey session:write — consent HISTORY_RETRIEVAL — `getChain`
- `PATCH /api/v1/consultations/:id` — jwt — apikey session:write — `update`
- `POST /api/v1/consultations/:id/prime` — jwt — apikey session:write — OCC + consent AI_DOCUMENTATION — `prime`
- `POST /api/v1/consultations/:id/close` — jwt — apikey session:write — OCC — `close`
- `POST /api/v1/consultations/:id/reopen` — jwt — apikey session:write — OCC — `reopen`
- `POST /api/v1/consultations/:id/recording/start` — jwt — apikey session:write — consent AI_DOCUMENTATION — `startRecording`
- `POST /api/v1/consultations/:id/recording/stop` — jwt — apikey session:write — `stopRecording`
- `GET /api/v1/consultations/:id/live-summary/stream` — SSE jwt — apikey session:write — `@TenantOwnedResource` + `@StreamScope(consultation_live_summary)` — `streamLiveSummary`
- `GET /api/v1/consultations/:id/harness-progress/stream` — SSE — apikey session:write — TenantOwned + StreamScope `consultation_harness_progress` — `streamHarnessProgress`
- `GET /api/v1/consultations/:id/harness-assurance/stream` — SSE — apikey session:write — TenantOwned + StreamScope `consultation_harness_assurance` — `streamHarnessAssurance`
- `GET /api/v1/consultations/:id/trajectory/stream` — SSE — apikey session:write — TenantOwned + StreamScope `consultation_trajectory` — `streamTrajectory`
- `GET /api/v1/consultations/:id/loop/stream` — SSE — apikey session:write — TenantOwned + StreamScope `consultation_loop` — `streamLoop`
- `GET /api/v1/consultations/:id/timeline` — jwt — session:write — `getTimeline`
- `POST /api/v1/consultations/:id/context` — jwt — session:write — `addContext`
- `GET /api/v1/consultations/:id/context` — jwt — session:write — `getContextItems`
- `GET /api/v1/consultations/:id/context/shared` — jwt — session:write — `getSharedContext`
- `GET /api/v1/consultations/:id/context/transcriptions` — jwt — session:write — `getTranscriptions`
- `GET /api/v1/consultations/:id/context/case-notes` — jwt — session:write — `getCaseNotes`
- `POST /api/v1/consultations/:id/recordings` — jwt — session:write — `addRecording`
- `GET /api/v1/consultations/:id/recordings` — jwt — session:write — `getRecordings`
- `PATCH /api/v1/consultations/:id/context/:contextId` — jwt — session:write — OCC — `updateContext`
- `DELETE /api/v1/consultations/:id/context/:contextId` — jwt — session:write — `deleteContext`
- `POST /api/v1/consultations/:id/highlights` — jwt — session:write — `createHighlight`
- `GET /api/v1/consultations/:id/highlights` — jwt — session:write — `getHighlights`
- `DELETE /api/v1/consultations/:id/highlights/:highlightId` — jwt — session:write — `deleteHighlight`
- `GET /api/v1/consultations/:id/context/:contextId/versions` — jwt — session:write — `getContextVersions`
- `GET /api/v1/consultations/:id/context/:contextId/versions/:versionNumber` — jwt — session:write — `getContextVersion`
- `POST /api/v1/consultations/:id/summary` — jwt — apikey **override** `consultation:report:write` — `generateSummary`
- `GET /api/v1/consultations/:id/summary` — jwt — apikey **override** `consultation:report:read` — `getSummaries`
- `POST /api/v1/consultations/:id/summary/pre-summary` — jwt — report:write — `generatePreSummary`
- `GET /api/v1/consultations/:id/summary/latest` — jwt — report:read — `getLatestSummary`
- `GET /api/v1/consultations/:id/summary/pre-summary/latest` — jwt — report:read — `getLatestPreSummary`
- `PATCH /api/v1/consultations/:id/summary/:summaryId` — jwt — report:write — OCC — `updateSummary`
- `GET /api/v1/consultations/:id/summary/:contextItemId/versions` — jwt — session:write — `getSummaryVersions`
- `GET /api/v1/consultations/:id/summary/:contextItemId/provenance` — jwt — session:write — `getSummaryProvenance`
- `GET /api/v1/consultations/:id/summary/:contextItemId/diff` — jwt — session:write — `diffSummaryVersions`
- `GET /api/v1/consultations/:id/summary/:contextItemId/tags` — jwt — session:write — `getSummaryTags`
- `POST /api/v1/consultations/:id/summary/:contextItemId/tags` — jwt — session:write — `tagSummary`
- `DELETE /api/v1/consultations/:id/summary/:contextItemId/tags/:tagId` — jwt — session:write — `deleteSummaryTag`
- `POST /api/v1/consultations/:id/summary/:contextItemId/extract-entities` — jwt — session:write — `extractEntities`
- `POST /api/v1/consultations/:id/summary/async` — jwt — report:write — `generateSummaryAsync`
- `POST /api/v1/consultations/:id/summary/pre-summary/async` — jwt — report:write — `generatePreSummaryAsync`
- `POST /api/v1/consultations/:id/summary/comprehensive` — jwt — session:write — `generateComprehensiveSummary`
- `POST /api/v1/consultations/:id/summary/comprehensive/async` — jwt — session:write — `generateComprehensiveSummaryAsync`
- `POST /api/v1/consultations/:id/summary/:contextItemId/approve` — jwt — session:write — OCC — `approveSummary`
- `GET /api/v1/consultations/:id/named-entities` — jwt — session:write — `getNamedEntities`

### HarnessAdminController

- **File:** `src/modules/harness-admin/harness-admin.controller.ts`
- **Prefix:** `admin/harness` → `api/v1/admin/harness`
- **api_count:** 26
- **Auth model:** JWT + API key
- **API key:** `admin:harness:manage`
- **JWT / other:** per-method HarnessPolicy / Eval / Workflow / Audit
- **Notes:** Policy, golden sets, Temporal workflow ops, live sessions.

- `GET /api/v1/admin/harness/policy` — jwt `read HarnessPolicy` — apikey yes — `getPolicy`
- `PATCH /api/v1/admin/harness/policy` — jwt `manage HarnessPolicy` — yes — OCC — `updatePolicy`
- `GET /api/v1/admin/harness/policy/global` — jwt `read HarnessPolicy` — yes — `getGlobalPolicy`
- `PATCH /api/v1/admin/harness/policy/global` — jwt `manage HarnessPolicy` — yes — OCC — `updateGlobalPolicy`
- `GET /api/v1/admin/harness/audit` — jwt `read HarnessAudit` — yes — `listAudit`
- `GET /api/v1/admin/harness/eval-runs` — jwt `read HarnessEval` — yes — `listEvalRuns`
- `GET /api/v1/admin/harness/eval-runs/:id` — jwt `read HarnessEval` — yes — `getEvalRun`
- `GET /api/v1/admin/harness/golden-sets` — jwt `read HarnessEval` — yes — `listGoldenSets`
- `GET /api/v1/admin/harness/golden-sets/:id` — jwt `read HarnessEval` — yes — `getGoldenSet`
- `GET /api/v1/admin/harness/golden-sets/:id/cases` — jwt `read HarnessEval` — yes — `listGoldenCases`
- `POST /api/v1/admin/harness/golden-sets` — jwt `manage HarnessEval` — yes — `createGoldenSet`
- `POST /api/v1/admin/harness/golden-sets/:id/cases` — jwt `manage HarnessEval` — yes — `createGoldenCase`
- `POST /api/v1/admin/harness/golden-sets/:id/run` — jwt `manage HarnessEval` — yes — `runGoldenSet`
- `GET /api/v1/admin/harness/gate-queue` — jwt `read HarnessWorkflow` — yes — `gateQueue`
- `GET /api/v1/admin/harness/edit-burden` — jwt `manage HarnessPolicy` — yes — `getEditBurden`
- `GET /api/v1/admin/harness/gate-edit-exemplars` — jwt `manage HarnessPolicy` — yes — `exportGateEditExemplars`
- `PATCH /api/v1/admin/harness/gate-edit-exemplars/:id/curation` — jwt `manage HarnessPolicy` — yes — `curateGateEditExemplar`
- `GET /api/v1/admin/harness/workflows` — jwt `read HarnessWorkflow` — yes — `listWorkflows`
- `GET /api/v1/admin/harness/workflows/:id` — jwt `read HarnessWorkflow` — yes — `describeWorkflow`
- `POST /api/v1/admin/harness/workflows/:id/cancel` — jwt `manage HarnessWorkflow` — yes — `cancelWorkflow`
- `POST /api/v1/admin/harness/workflows/:id/terminate` — jwt `manage HarnessWorkflow` — yes — `terminateWorkflow`
- `POST /api/v1/admin/harness/workflows/:id/signal` — jwt `manage HarnessWorkflow` — yes — `signalWorkflow`
- `GET /api/v1/admin/harness/live/sessions` — jwt `read HarnessWorkflow` — yes — `listLiveSessions`
- `GET /api/v1/admin/harness/live/sessions/:id` — jwt `read HarnessWorkflow` — yes — `getLiveSession`
- `GET /api/v1/admin/harness/live/config` — jwt `read HarnessPolicy` — yes — `getLiveConfig`
- `PATCH /api/v1/admin/harness/live/config` — jwt `manage HarnessPolicy` — yes — `updateLiveConfig`

### UserController

- **File:** `src/modules/user/user.controller.ts`
- **Prefix:** `admin/users` → `api/v1/admin/users`
- **api_count:** 21
- **Auth model:** JWT + API key
- **API key:** `admin:user:write`
- **JWT / other:** manage:User (assign-role → UserRoleAssignment)
- **Notes:** Shares prefix with UserDepartments + AdminImpersonation.

- `POST /api/v1/admin/users` — jwt manage:User — apikey yes — create
- `PATCH /api/v1/admin/users/:id/departments` — jwt manage:User — setDepartments — extras: assertUserInScope
- `GET /api/v1/admin/users` — jwt manage:User — fetchAll — extras: tenant-scoped list
- `GET /api/v1/admin/users/export` — jwt manage:User — fetchAll — exportUsers
- `GET /api/v1/admin/users/:id` — jwt manage:User — fetchAll — fetchById
- `GET /api/v1/admin/users/tenant/:tenantId` — jwt manage:User — fetchByTenant — extras: assertCanReadTenant
- `PATCH /api/v1/admin/users/:id` — jwt manage:User — fetchByTenant — update
- `PATCH /api/v1/admin/users/:id/status` — jwt manage:User — fetchByTenant — updateStatus
- `DELETE /api/v1/admin/users/:id` — jwt manage:User — fetchByTenant — delete
- `DELETE /api/v1/admin/users/bulk` — jwt manage:User — fetchByTenant — bulkDelete
- `POST /api/v1/admin/users/bulk-actions` — jwt manage:User — bulkActions — extras: assign-role arm needs manage:UserRoleAssignment
- `GET /api/v1/admin/users/:id/api-keys` — jwt manage:User — bulkActions — fetchUserApiKeys
- `GET /api/v1/admin/users/:id/settings` — jwt manage:User — bulkActions — fetchUserSettings
- `PATCH /api/v1/admin/users/:id/settings/:namespace/:key` — jwt manage:User — bulkActions — updateUserSetting
- `POST /api/v1/admin/users/:id/reset-password` — jwt manage:User — bulkActions — resetPassword
- `GET /api/v1/admin/users/:id/roles` — jwt manage:User — bulkActions — fetchUserRoleAssignments
- `POST /api/v1/admin/users/:id/roles` — jwt manage:UserRoleAssignment (method override) — apikey yes — assignRole
- `DELETE /api/v1/admin/users/:id/roles/:assignmentId` — jwt manage:User — apikey yes — removeRole
- `GET /api/v1/admin/users/:id/profile` — jwt manage:User — apikey yes — fetchUserProfile
- `PATCH /api/v1/admin/users/:id/profile` — jwt manage:User — apikey yes — updateUserProfile
- `GET /api/v1/admin/users/:id/voice-profiles` — jwt manage:User — apikey yes — fetchUserVoiceProfiles

### TranscriptionJobController

- **File:** `src/modules/streaming/transcription-job.controller.ts`
- **Prefix:** `audio/transcription-jobs` → `api/v1/audio/transcription-jobs`
- **api_count:** 20
- **Auth model:** JWT + API key
- **API key:** `stt:transcription:write`
- **JWT / other:** @Authorize()
- **Notes:** 1 @Sse() job stream. Stream session CRUD + TenantOwnedResource.

- `POST /api/v1/audio/transcription-jobs` — jwt auth — apikey yes — create
- `POST /api/v1/audio/transcription-jobs/batch` — jwt auth — apikey yes — createBatch
- `POST /api/v1/audio/transcription-jobs/streaming` — jwt auth — apikey yes — createStreaming
- `GET /api/v1/audio/transcription-jobs/stats` — jwt auth — apikey yes — getStats
- `GET /api/v1/audio/transcription-jobs/status/:status` — jwt auth — apikey yes — getByStatus
- `POST /api/v1/audio/transcription-jobs/transcribe` — jwt auth — apikey yes — transcribeFile
- `GET /api/v1/audio/transcription-jobs/consultation/:consultationId` — jwt auth — apikey yes — getByConsultation
- `GET /api/v1/audio/transcription-jobs/limits` — jwt auth — apikey yes — getBatchLimits
- `GET /api/v1/audio/transcription-jobs/fallback` — jwt auth — apikey yes — getFallbackProvider
- `GET /api/v1/audio/transcription-jobs/language-modes` — jwt auth — apikey yes — getLanguageModes
- `POST /api/v1/audio/transcription-jobs/stream/session` — jwt auth — apikey yes — createStreamSession
- `DELETE /api/v1/audio/transcription-jobs/stream/session/:sessionId` — jwt auth — closeStreamSession — extras: TenantOwnedResource(StreamSession)
- `POST /api/v1/audio/transcription-jobs/stream/session/:sessionId/refresh-ticket` — jwt auth — refreshStreamTicket — extras: TenantOwnedResource
- `POST /api/v1/audio/transcription-jobs/stream/session/:sessionId/switch-to-fallback` — jwt auth — switchStreamSessionToFallback — extras: TenantOwnedResource
- `POST /api/v1/audio/transcription-jobs/stream/session/:sessionId/switch-to-primary` — jwt auth — switchStreamSessionToPrimary — extras: TenantOwnedResource
- `GET /api/v1/audio/transcription-jobs/:id` — jwt auth — getById — extras: TenantOwnedResource(TranscriptionJob)
- `GET /api/v1/audio/transcription-jobs/:id/stream` — jwt auth — streamJob — extras: `@Sse()` + `@Get()` counted as **1**; StreamScope; TenantOwnedResource; JWT or ticket
- `POST /api/v1/audio/transcription-jobs/:id/cancel` — jwt auth — cancel — extras: TenantOwnedResource
- `POST /api/v1/audio/transcription-jobs/:id/retry` — jwt auth — retry — extras: TenantOwnedResource
- `GET /api/v1/audio/transcription-jobs` — jwt auth — retry — list

### HarnessInternalController

- **File:** `src/modules/consultation/harness-internal.controller.ts`
- **Prefix:** `internal/harness` → `api/v1/internal/harness`
- **api_count:** 18
- **Auth model:** Service token
- **API key:** `n/a — X-Service-Token (HarnessServiceTokenGuard)`
- **JWT / other:** skipped (@Public)
- **Notes:** Harness worker callbacks. UnifiedAuth skipped.

- `GET /api/v1/internal/harness/policy` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `getEffectivePolicy`
- `GET /api/v1/internal/harness/prompt-templates/:id/resolved` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `getResolvedPromptTemplate`
- `GET /api/v1/internal/harness/mcp-token` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `resolveMcpToken`
- `POST /api/v1/internal/harness/consultations/:id/entities` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `persistEntities`
- `GET /api/v1/internal/harness/consultations/:id/entities` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `getEntities`
- `POST /api/v1/internal/harness/consultations/:id/assemble` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `assemble`
- `POST /api/v1/internal/harness/consultations/:id/draft` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `persistDraft`
- `POST /api/v1/internal/harness/consultations/:id/gate-decision` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `recordGateDecision`
- `POST /api/v1/internal/harness/consultations/:id/escalation` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `recordEscalation`
- `POST /api/v1/internal/harness/consultations/:id/assurance` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `finalizeAssurance`
- `POST /api/v1/internal/harness/consultations/:id/assurance-event` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `reportAssuranceClaim`
- `POST /api/v1/internal/harness/consultations/:id/progress` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `reportProgress`
- `POST /api/v1/internal/harness/consultations/:id/loop-event` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `reportLoopEvent`
- `POST /api/v1/internal/harness/trajectory` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `reportTrajectory`
- `GET /api/v1/internal/harness/loop-config` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `getLoopConfig`
- `GET /api/v1/internal/harness/consultations/:id/context-items/:contextItemId/extracted-text` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `getExtractedText`
- `POST /api/v1/internal/harness/consultations/:id/live-documentation/start` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `startLiveDocumentation`
- `POST /api/v1/internal/harness/consultations/:id/live-documentation/stop` — skipped (@Public) — n/a — X-Service-Token (HarnessServiceTokenGuard) — `stopLiveDocumentation`

### PromptManagementController

- **File:** `src/modules/prompt-management/prompt-management.controller.ts`
- **Prefix:** `admin/prompt-templates` → `api/v1/admin/prompt-templates`
- **api_count:** 16
- **Auth model:** JWT + API key
- **API key:** `admin:prompt-template:manage`
- **JWT / other:** manage:PromptTemplate (method Can* overrides)
- **Notes:** Approve is SYSTEM-row SUPER_ADMIN in service. Assign-department uses manage:Department.

- `POST /api/v1/admin/prompt-templates` — jwt **`create:PromptTemplate`** — apikey that scope
- `GET /api/v1/admin/prompt-templates` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/analytics/usage` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/usage-records` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/:id` — jwt `manage:PromptTemplate` — apikey same
- `PATCH /api/v1/admin/prompt-templates/:id` — jwt **`update:PromptTemplate`** — apikey same — `@RequiresIfMatch`
- `DELETE /api/v1/admin/prompt-templates/:id` — jwt **`delete:PromptTemplate`** — apikey same
- `GET /api/v1/admin/prompt-templates/:id/versions` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/:id/versions/:versionNumber` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/:id/versions/:from/diff/:to` — jwt `manage:PromptTemplate` — apikey same
- `GET /api/v1/admin/prompt-templates/:id/usage` — jwt `manage:PromptTemplate` — apikey same
- `POST /api/v1/admin/prompt-templates/:id/test` — jwt **`update:PromptTemplate`** — apikey same
- `POST /api/v1/admin/prompt-templates/:id/test/finalize` — jwt **`update:PromptTemplate`** — apikey same — `@RequiresIfMatch`
- `POST /api/v1/admin/prompt-templates/:id/approve` — jwt `manage:PromptTemplate` (class; **no handler decorator**) — apikey same — `@RequiresIfMatch`; **OD-3 imperative: SYSTEM row SUPER_ADMIN-only, tenant row `manage:PromptTemplate`**
- `POST /api/v1/admin/prompt-templates/:id/versions/:versionNumber/activate` — jwt **`update:PromptTemplate`** — apikey same
- `POST /api/v1/admin/prompt-templates/assign-department` — jwt **`manage:Department`** — apikey same (class scope still applies to API keys)

### TenantController

- **File:** `src/modules/tenant/tenant.controller.ts`
- **Prefix:** `admin/tenants` → `api/v1/admin/tenants`
- **api_count:** 15
- **Auth model:** JWT + API key
- **API key:** `admin:tenant:write`
- **JWT / other:** manage|update:Tenant (lifecycle = manage)
- **Notes:** Shares prefix with provision + pipeline-resync.

- `POST /api/v1/admin/tenants` — jwt manage:Tenant — apikey yes — create
- `GET /api/v1/admin/tenants` — jwt manage\|update:Tenant — apikey yes — fetchAll — extras: non-super-admin pinned to own tenant
- `GET /api/v1/admin/tenants/user/:userId` — jwt manage\|update:Tenant — apikey yes — fetchByUserId
- `GET /api/v1/admin/tenants/:id/usage` — jwt manage\|update:Tenant — apikey yes — getUsage — extras: assertTenantInScope
- `GET /api/v1/admin/tenants/:id` — jwt manage\|update:Tenant — apikey yes — fetchById
- `GET /api/v1/admin/tenants/code-name/:code-name` — jwt manage\|update:Tenant — apikey yes — fetchByCodeName — extras: assertTenantInScope
- `PATCH /api/v1/admin/tenants/:id` — jwt manage\|update:Tenant — apikey yes — update — extras: `@RequiresIfMatch`; assertTenantInScope
- `DELETE /api/v1/admin/tenants/:id` — jwt manage:Tenant — apikey yes — delete
- `POST /api/v1/admin/tenants/:id/suspend` — jwt manage:Tenant — apikey yes — suspend
- `POST /api/v1/admin/tenants/:id/archive` — jwt manage:Tenant — apikey yes — archive
- `POST /api/v1/admin/tenants/:id/restore` — jwt manage:Tenant — apikey yes — restore
- `GET /api/v1/admin/tenants/:id/tags` — jwt manage\|update:Tenant — apikey yes — getTags
- `PUT /api/v1/admin/tenants/:id/tags` — jwt manage\|update:Tenant — apikey yes — setTags
- `GET /api/v1/admin/tenants/configs/:identifier` — jwt manage\|update:Tenant — apikey yes — fetchTenantConfigs — extras: assertConfigInScope
- `PATCH /api/v1/admin/tenants/configs/:identifier` — jwt manage\|update:Tenant — apikey yes — updateTenantConfigs

### AudioPipelineController

- **File:** `src/modules/pipeline/audio-pipeline.controller.ts`
- **Prefix:** `admin/audio/pipelines` → `api/v1/admin/audio/pipelines`
- **api_count:** 14
- **Auth model:** JWT + API key
- **API key:** `admin:audio-pipeline:manage`
- **JWT / other:** manage:AsrPipeline
- **Notes:** YAML validate, clone, tenant assign, versions.

- `POST /api/v1/admin/audio/pipelines` — manage:AsrPipeline — admin:audio-pipeline:manage — `create`
- `GET /api/v1/admin/audio/pipelines` — manage:AsrPipeline — admin:audio-pipeline:manage — `fetchAll`
- `GET /api/v1/admin/audio/pipelines/list` — manage:AsrPipeline — admin:audio-pipeline:manage — `list`
- `GET /api/v1/admin/audio/pipelines/:id` — manage:AsrPipeline — admin:audio-pipeline:manage — `fetchById`
- `GET /api/v1/admin/audio/pipelines/slug/:slug` — manage:AsrPipeline — admin:audio-pipeline:manage — `fetchBySlug`
- `PATCH /api/v1/admin/audio/pipelines/:id` — manage:AsrPipeline — admin:audio-pipeline:manage — OCC — `update`
- `DELETE /api/v1/admin/audio/pipelines/:id` — manage:AsrPipeline — admin:audio-pipeline:manage — `delete`
- `POST /api/v1/admin/audio/pipelines/:id/clone` — manage:AsrPipeline — admin:audio-pipeline:manage — `clone`
- `POST /api/v1/admin/audio/pipelines/validate` — manage:AsrPipeline — admin:audio-pipeline:manage — `validateYaml`
- `POST /api/v1/admin/audio/pipelines/:id/assign-tenant` — manage:AsrPipeline — admin:audio-pipeline:manage — `assignTenant`
- `POST /api/v1/admin/audio/pipelines/:id/set-default` — manage:AsrPipeline — admin:audio-pipeline:manage — `setDefault`
- `PATCH /api/v1/admin/audio/pipelines/:id/toggle` — manage:AsrPipeline — admin:audio-pipeline:manage — OCC — `toggle`
- `GET /api/v1/admin/audio/pipelines/:id/versions` — manage:AsrPipeline — admin:audio-pipeline:manage — `listVersions`
- `GET /api/v1/admin/audio/pipelines/:id/versions/:versionNumber` — manage:AsrPipeline — admin:audio-pipeline:manage — `getVersion`

### DnaWritingStyleController

- **File:** `src/modules/dna-writing-style/dna-writing-style.controller.ts`
- **Prefix:** `dna-writing-styles` → `api/v1/dna-writing-styles`
- **api_count:** 14
- **Auth model:** JWT only
- **API key:** `forbidden (@ForbidApiKey)`
- **JWT / other:** @Authorize(); owner/doctor checks in service
- **Notes:** SSE job stream has no @StreamScope — ticket will 401.

- `POST /api/v1/dna-writing-styles/generate` — jwt — no ForbidApiKey — `generate`
- `GET /api/v1/dna-writing-styles/my-style` — jwt — no — `getMyStyle`
- `GET /api/v1/dna-writing-styles/my-style/redaction-rules` — jwt — no — `getMyRedactionRules`
- `GET /api/v1/dna-writing-styles/settings` — jwt — no — `getSettings`
- `PUT /api/v1/dna-writing-styles/settings` — jwt — no — `setSettings`
- `GET /api/v1/dna-writing-styles/mine` — jwt — no — `getMine`
- `GET /api/v1/dna-writing-styles/doctor/:doctorId` — jwt — no — self-only — `getByDoctor`
- `PATCH /api/v1/dna-writing-styles/:reportId` — jwt — no — OCC — `update`
- `PATCH /api/v1/dna-writing-styles/:reportId/default` — jwt — no — `setDefault`
- `DELETE /api/v1/dna-writing-styles/my-style` — jwt — no — `resetMyStyle`
- `DELETE /api/v1/dna-writing-styles/:reportId` — jwt — no — `deleteReport`
- `GET /api/v1/dna-writing-styles/:reportId/versions` — jwt — no — `getVersions`
- `GET /api/v1/dna-writing-styles/jobs/:jobId` — jwt — no — `getJobStatus`
- `GET /api/v1/dna-writing-styles/jobs/:jobId/stream` — SSE jwt — no — `streamJobStatus`

### QueueAdminController

- **File:** `src/modules/queue-admin/queue-admin.controller.ts`
- **Prefix:** `admin/queues` → `api/v1/admin/queues`
- **api_count:** 12
- **Auth model:** JWT + API key
- **API key:** `admin:queue:manage`
- **JWT / other:** manage:all
- **Notes:** SUPER_ADMIN BullMQ ops.

- `GET /api/v1/admin/queues` — jwt manage:all — apikey yes (`admin:queue:manage`) — listQueues
- `GET /api/v1/admin/queues/health/redis` — jwt manage:all — apikey yes (`admin:queue:manage`) — getRedisHealth
- `GET /api/v1/admin/queues/:queueName` — jwt manage:all — apikey yes (`admin:queue:manage`) — getQueue
- `POST /api/v1/admin/queues/:queueName/pause` — jwt manage:all — apikey yes (`admin:queue:manage`) — pauseQueue
- `POST /api/v1/admin/queues/:queueName/resume` — jwt manage:all — apikey yes (`admin:queue:manage`) — resumeQueue
- `POST /api/v1/admin/queues/:queueName/clean` — jwt manage:all — apikey yes (`admin:queue:manage`) — cleanQueue
- `GET /api/v1/admin/queues/:queueName/jobs` — jwt manage:all — apikey yes (`admin:queue:manage`) — listJobs
- `POST /api/v1/admin/queues/:queueName/jobs/bulk` — jwt manage:all — apikey yes (`admin:queue:manage`) — bulkJobAction
- `GET /api/v1/admin/queues/:queueName/jobs/:jobId` — jwt manage:all — apikey yes (`admin:queue:manage`) — getJob
- `POST /api/v1/admin/queues/:queueName/jobs/:jobId/retry` — jwt manage:all — apikey yes (`admin:queue:manage`) — retryJob
- `POST /api/v1/admin/queues/:queueName/jobs/:jobId/promote` — jwt manage:all — apikey yes (`admin:queue:manage`) — promoteJob
- `DELETE /api/v1/admin/queues/:queueName/jobs/:jobId` — jwt manage:all — apikey yes (`admin:queue:manage`) — removeJob

### TenantBucketController

- **File:** `src/modules/tenant-bucket/tenant-bucket.controller.ts`
- **Prefix:** `admin/tenants/storage/buckets` → `api/v1/admin/tenants/storage/buckets`
- **api_count:** 12
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-storage:manage`
- **JWT / other:** class manage:Tenant; methods Can*:Storage
- **Notes:** TenantOwnedResource on named buckets.

- `GET /api/v1/admin/tenants/storage/buckets` — jwt read:Storage — apikey yes — listBuckets
- `GET /api/v1/admin/tenants/storage/buckets/defaults` — jwt read:Storage — apikey yes — getDefaultBuckets
- `PUT /api/v1/admin/tenants/storage/buckets/defaults` — jwt update:Storage — apikey yes — setDefaultBuckets
- `GET /api/v1/admin/tenants/storage/buckets/:id` — jwt read:Storage — apikey yes — getBucket — extras: TenantOwnedResource
- `GET /api/v1/admin/tenants/storage/buckets/:id/tree` — jwt read:Storage — apikey yes — getBucketTree — extras: TenantOwnedResource
- `POST /api/v1/admin/tenants/storage/buckets` — jwt create:Storage — apikey yes — createBucket
- `DELETE /api/v1/admin/tenants/storage/buckets/:id` — jwt delete:Storage — apikey yes — deleteBucket — extras: TenantOwnedResource
- `GET /api/v1/admin/tenants/storage/buckets/:id/objects` — jwt read:Storage — apikey yes — listObjects — extras: TenantOwnedResource(super-admin)
- `POST /api/v1/admin/tenants/storage/buckets/:id/objects` — jwt create:Storage — apikey yes — uploadObject — extras: TenantOwnedResource
- `DELETE /api/v1/admin/tenants/storage/buckets/:id/objects` — jwt delete:Storage — apikey yes — deleteObject — extras: TenantOwnedResource
- `POST /api/v1/admin/tenants/storage/buckets/provision/:tenantId` — jwt manage:Tenant — apikey yes — provisionSystemBuckets
- `GET /api/v1/admin/tenants/storage/buckets/:id/presigned-url` — jwt read:Storage — apikey yes — getPresignedUrl — extras: TenantOwnedResource

### EntitlementsAdminController

- **File:** `src/modules/entitlements/entitlements-admin.controller.ts`
- **Prefix:** `admin/entitlements` → `api/v1/admin/entitlements`
- **api_count:** 11
- **Auth model:** JWT + API key
- **API key:** `admin:entitlement:manage`
- **JWT / other:** manage:all
- **Notes:** Plans, tenant overrides, trial expiry.

- `GET /api/v1/admin/entitlements/enabled` — manage:all — admin:entitlement:manage — `getEnabled`
- `PUT /api/v1/admin/entitlements/enabled` — manage:all — admin:entitlement:manage — `setEnabled`
- `GET /api/v1/admin/entitlements/plans` — manage:all — admin:entitlement:manage — `listPlans`
- `GET /api/v1/admin/entitlements/plans/:plan` — manage:all — admin:entitlement:manage — `getPlan`
- `PATCH /api/v1/admin/entitlements/plans/:plan` — manage:all — admin:entitlement:manage — `updatePlan`
- `GET /api/v1/admin/entitlements/tenants/:tenantId` — manage:all — admin:entitlement:manage — `getTenantSnapshot`
- `GET /api/v1/admin/entitlements/tenants/:tenantId/override` — manage:all — admin:entitlement:manage — `getOverride`
- `PUT /api/v1/admin/entitlements/tenants/:tenantId/override` — manage:all — admin:entitlement:manage — `upsertOverride`
- `DELETE /api/v1/admin/entitlements/tenants/:tenantId/override` — manage:all — admin:entitlement:manage — `clearOverride`
- `POST /api/v1/admin/entitlements/tenants/:tenantId/downgrade` — manage:all — admin:entitlement:manage — `triggerDowngrade`
- `POST /api/v1/admin/entitlements/trial-expiry/run` — manage:all — admin:entitlement:manage — `runTrialExpiry`

### DepartmentController

- **File:** `src/modules/department/department.controller.ts`
- **Prefix:** `admin/departments` → `api/v1/admin/departments`
- **api_count:** 10
- **Auth model:** JWT + API key
- **API key:** `admin:department:manage`
- **JWT / other:** manage:Department
- **Notes:** Tree + users + prompt-config OCC.

- `POST /api/v1/admin/departments` — manage:Department — admin:department:manage — `create`
- `GET /api/v1/admin/departments` — manage:Department — admin:department:manage — `fetchAll`
- `GET /api/v1/admin/departments/roots` — manage:Department — admin:department:manage — `fetchRoots`
- `GET /api/v1/admin/departments/:id` — manage:Department — admin:department:manage — `fetchById`
- `GET /api/v1/admin/departments/code/:code` — manage:Department — admin:department:manage — `fetchByCode`
- `GET /api/v1/admin/departments/:id/children` — manage:Department — admin:department:manage — `fetchChildren`
- `GET /api/v1/admin/departments/:id/users` — manage:Department — admin:department:manage — `fetchUsers`
- `PATCH /api/v1/admin/departments/:id` — manage:Department — admin:department:manage — OCC — `update`
- `PATCH /api/v1/admin/departments/:id/prompt-config` — jwt `@Authorize([manage,Department])` — OCC — `updatePromptConfig`
- `DELETE /api/v1/admin/departments/:id` — manage:Department — admin:department:manage — `delete`

### RolesController

- **File:** `src/modules/rbac/roles.controller.ts`
- **Prefix:** `admin/rbac/roles` → `api/v1/admin/rbac/roles`
- **api_count:** 10
- **Auth model:** JWT + API key
- **API key:** `admin:role:write`
- **JWT / other:** manage:Role (reads CanAny read|manage)
- **Notes:** Break-glass on deletes.

- `GET /api/v1/admin/rbac/roles` — jwt read\|manage:Role — apikey yes — findAll
- `GET /api/v1/admin/rbac/roles/:id` — jwt read\|manage:Role — apikey yes — findOne
- `GET /api/v1/admin/rbac/roles/:id/members` — jwt read\|manage:Role — apikey yes — listMembers — extras: tenant-scoped members
- `POST /api/v1/admin/rbac/roles` — jwt manage:Role — apikey yes — create
- `POST /api/v1/admin/rbac/roles/:id/clone` — jwt create:Role — apikey yes — clone
- `PUT /api/v1/admin/rbac/roles/:id` — jwt manage:Role — apikey yes — update
- `PATCH /api/v1/admin/rbac/roles/:id` — jwt manage:Role — apikey yes — patch
- `DELETE /api/v1/admin/rbac/roles/:id` — jwt manage:Role — apikey yes — remove — extras: break-glass body
- `POST /api/v1/admin/rbac/roles/:roleId/policies/:policyId` — jwt manage:RolePolicy — apikey yes — assignPolicy
- `DELETE /api/v1/admin/rbac/roles/:roleId/policies/:policyId` — jwt manage:RolePolicy — apikey yes — removePolicy — extras: break-glass

### StorageController

- **File:** `src/modules/storage/storage.controller.ts`
- **Prefix:** `storage` → `api/v1/storage`
- **api_count:** 10
- **Auth model:** JWT + API key
- **API key:** `media:file:write`
- **JWT / other:** per-verb Storage
- **Notes:** MinIO/S3. TenantOwnedResource on named buckets.

- `GET /api/v1/storage/buckets` — jwt read:Storage — apikey yes — listBuckets
- `POST /api/v1/storage/buckets` — jwt create:Storage — apikey yes — createBucket
- `DELETE /api/v1/storage/buckets/:name` — jwt delete:Storage — apikey yes — deleteBucket — extras: TenantOwnedResource
- `PATCH /api/v1/storage/buckets/:name` — jwt update:Storage — apikey yes — updateBucket — extras: TenantOwnedResource
- `GET /api/v1/storage/buckets/:name` — jwt read:Storage — apikey yes — getBucket — extras: TenantOwnedResource
- `GET /api/v1/storage/buckets/:name/files` — jwt read:Storage — apikey yes — listFiles — extras: TenantOwnedResource
- `POST /api/v1/storage/buckets/:name/files` — jwt create:Storage — apikey yes — uploadFile — extras: TenantOwnedResource
- `GET /api/v1/storage/buckets/:name/files/:key` — jwt read:Storage — apikey yes — getFileInfo — extras: TenantOwnedResource
- `DELETE /api/v1/storage/buckets/:name/files/:key` — jwt delete:Storage — apikey yes — deleteFile — extras: TenantOwnedResource
- `GET /api/v1/storage/health` — jwt read:Storage — apikey yes — checkHealth

### SttInternalController

- **File:** `src/modules/internal/stt-internal.controller.ts`
- **Prefix:** `internal/stt` → `api/v1/internal/stt`
- **api_count:** 10
- **Auth model:** JWT + API key
- **API key:** `internal:stt:worker (X-Internal-Service-Key)`
- **JWT / other:** @Authorize() — worker rejects JWT in handler
- **Notes:** Exception to /internal Public+token pattern. Tenant pin needs platform key.

- `POST /api/v1/internal/stt/transcripts` — jwt auth — apikey yes (`internal:stt:worker`) — createTranscript
- `POST /api/v1/internal/stt/streaming/usage` — jwt auth — apikey yes (`internal:stt:worker`) — recordStreamingUsage
- `PATCH /api/v1/internal/stt/jobs/:id/start` — jwt auth — apikey yes (`internal:stt:worker`) — startJob
- `PATCH /api/v1/internal/stt/jobs/:id/progress` — jwt auth — apikey yes (`internal:stt:worker`) — updateProgress
- `PATCH /api/v1/internal/stt/jobs/:id/complete` — jwt auth — apikey yes (`internal:stt:worker`) — completeJob
- `PATCH /api/v1/internal/stt/jobs/:id/fail` — jwt auth — apikey yes (`internal:stt:worker`) — failJob
- `GET /api/v1/internal/stt/jobs/:id/status` — jwt auth — apikey yes (`internal:stt:worker`) — getJobStatus
- `POST /api/v1/internal/stt/audio-records` — jwt auth — apikey yes (`internal:stt:worker`) — createAudioRecord
- `POST /api/v1/internal/stt/media` — jwt auth — apikey yes (`internal:stt:worker`) — createMedia
- `GET /api/v1/internal/stt/provider-overrides` — jwt auth — getProviderOverrides — extras: `X-Internal-Service-Key` + `X-Internal-Tenant-Id`

### ApiKeyController

- **File:** `src/modules/api-key/api-key.controller.ts`
- **Prefix:** `admin/api-keys` → `api/v1/admin/api-keys`
- **api_count:** 9
- **Auth model:** JWT + API key
- **API key:** `admin:apikey:write`
- **JWT / other:** manage:ApiKey + per-verb Can*
- **Notes:** Create/rotate/revoke plus scopes catalog.

- `GET /api/v1/admin/api-keys/scopes` — jwt `CanRead(ApiKey)` — apikey yes `admin:apikey:write` — `getAvailableScopes`
- `POST /api/v1/admin/api-keys` — jwt `CanCreate(ApiKey)` — apikey yes `admin:apikey:write` — `create`
- `GET /api/v1/admin/api-keys` — jwt `CanRead(ApiKey)` — apikey yes `admin:apikey:write` — `fetchAll`
- `GET /api/v1/admin/api-keys/:id` — jwt `CanRead(ApiKey)` — apikey yes `admin:apikey:write` — `fetchById`
- `PATCH /api/v1/admin/api-keys/:id` — jwt `CanUpdate(ApiKey)` — apikey yes `admin:apikey:write` — `update`
- `DELETE /api/v1/admin/api-keys/:id` — jwt `CanDelete(ApiKey)` — apikey yes `admin:apikey:write` — `delete`
- `POST /api/v1/admin/api-keys/:id/revoke` — jwt `CanUpdate(ApiKey)` — apikey yes `admin:apikey:write` — `revoke`
- `POST /api/v1/admin/api-keys/:id/rotate` — jwt `CanUpdate(ApiKey)` — apikey yes `admin:apikey:write` — `rotate`
- `GET /api/v1/admin/api-keys/:id/usage` — jwt `CanRead(ApiKey)` — apikey yes `admin:apikey:write` — `getUsage`

### DepartmentAgentController

- **File:** `src/modules/department-agent/department-agent.controller.ts`
- **Prefix:** `admin/department-agents` → `api/v1/admin/department-agents`
- **api_count:** 9
- **Auth model:** JWT + API key
- **API key:** `admin:department-agent:manage`
- **JWT / other:** manage:DepartmentAgent
- **Notes:** Shares prefix with resync controller.

- `GET /api/v1/admin/department-agents` — manage:DepartmentAgent — admin:department-agent:manage — `list`
- `GET /api/v1/admin/department-agents/:id` — manage:DepartmentAgent — admin:department-agent:manage — `getById`
- `GET /api/v1/admin/department-agents/:id/versions` — manage:DepartmentAgent — admin:department-agent:manage — `listVersions`
- `POST /api/v1/admin/department-agents` — manage:DepartmentAgent — admin:department-agent:manage — `create`
- `PATCH /api/v1/admin/department-agents/:id` — manage:DepartmentAgent — admin:department-agent:manage — OCC — `update`
- `DELETE /api/v1/admin/department-agents/:id` — manage:DepartmentAgent — admin:department-agent:manage — `delete`
- `POST /api/v1/admin/department-agents/:id/set-default` — manage:DepartmentAgent — admin:department-agent:manage — `setDefault`
- `POST /api/v1/admin/department-agents/:id/pin` — manage:DepartmentAgent — admin:department-agent:manage — `pin`
- `POST /api/v1/admin/department-agents/:id/clone` — manage:DepartmentAgent — admin:department-agent:manage — `clone`

### ConsultationContextSchemaAdminController

- **File:** `src/modules/consultation-context-schema/consultation-context-schema.controller.ts`
- **Prefix:** `admin/consultation-context-schemas` → `api/v1/admin/consultation-context-schemas`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:consultation-context-schema:manage`
- **JWT / other:** manage:ConsultationContextSchema
- **Notes:** Same file as MyTenantContextSchemaController.

- `GET /api/v1/admin/consultation-context-schemas` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `list`
- `GET /api/v1/admin/consultation-context-schemas/:id` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `getById`
- `GET /api/v1/admin/consultation-context-schemas/:id/versions` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `listVersions`
- `POST /api/v1/admin/consultation-context-schemas` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `create`
- `PATCH /api/v1/admin/consultation-context-schemas/:id` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — OCC — `update`
- `POST /api/v1/admin/consultation-context-schemas/:id/publish` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `publish`
- `POST /api/v1/admin/consultation-context-schemas/:id/pin` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `pin`
- `DELETE /api/v1/admin/consultation-context-schemas/:id` — jwt manage ConsultationContextSchema — apikey yes `admin:consultation-context-schema:manage` — `deleteById`

### DnaWritingStyleAdminController

- **File:** `src/modules/dna-writing-style/dna-writing-style-admin.controller.ts`
- **Prefix:** `admin/dna-writing-styles` → `api/v1/admin/dna-writing-styles`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:dna-writing-style:manage`
- **JWT / other:** manage:DnaWritingStyleReport
- **Notes:** SSE job stream with StreamScope dna_job.

- `GET /api/v1/admin/dna-writing-styles/dashboard` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `getDashboard`
- `GET /api/v1/admin/dna-writing-styles` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `list`
- `GET /api/v1/admin/dna-writing-styles/doctor/:doctorId` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `getReportForDoctor`
- `PATCH /api/v1/admin/dna-writing-styles/:reportId` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — OCC — `update`
- `POST /api/v1/admin/dna-writing-styles/generate/:doctorId` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `generateForDoctor`
- `GET /api/v1/admin/dna-writing-styles/:reportId/versions` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `getVersions`
- `GET /api/v1/admin/dna-writing-styles/jobs/:jobId` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — `getJobStatus`
- `GET /api/v1/admin/dna-writing-styles/jobs/:jobId/stream` — manage:DnaWritingStyleReport — admin:dna-writing-style:manage — SSE + `@StreamScope(dna_job)` — `streamJobStatus`

### GlobalSettingController

- **File:** `src/modules/global-setting/global-setting.controller.ts`
- **Prefix:** `admin/settings` → `api/v1/admin/settings`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:settings:manage`
- **JWT / other:** manage:GlobalSetting (reveal/rotate → manage:all)
- **Notes:** Shares prefix with catalog + registry-write.

- `POST /api/v1/admin/settings` — jwt `CanCreate(GlobalSetting)` — apikey yes — `create`
- `GET /api/v1/admin/settings` — jwt `CanRead(GlobalSetting)` — yes — `fetchAll`
- `GET /api/v1/admin/settings/tenant/:tenantId` — jwt `CanRead(GlobalSetting)` — yes — `fetchByTenant`
- `GET /api/v1/admin/settings/:id` — jwt `CanRead(GlobalSetting)` — yes — `fetchById`
- `PATCH /api/v1/admin/settings/:id` — jwt `CanUpdate(GlobalSetting)` — yes — OCC — `update`
- `DELETE /api/v1/admin/settings/:id` — jwt `CanDelete(GlobalSetting)` — yes — `delete`
- `POST /api/v1/admin/settings/:id/reveal` — jwt **override** `manage:all` — yes — step-up password — `reveal`
- `POST /api/v1/admin/settings/:id/rotate` — jwt **override** `manage:all` — yes — OCC + step-up — `rotate`

### TenantIdpConfigAdminController

- **File:** `src/modules/tenant-idp-config/tenant-idp-config-admin.controller.ts`
- **Prefix:** `admin/tenant-idp-config` → `api/v1/admin/tenant-idp-config`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-idp-config:manage`
- **JWT / other:** read/manage:TenantIdentityProvider
- **Notes:** Test + directory sync.

- `GET /api/v1/admin/tenant-idp-config` — jwt read:TenantIdentityProvider — apikey yes — list
- `GET /api/v1/admin/tenant-idp-config/:id` — jwt read:TenantIdentityProvider — apikey yes — getById
- `POST /api/v1/admin/tenant-idp-config` — jwt manage:TenantIdentityProvider — apikey yes — create
- `PUT /api/v1/admin/tenant-idp-config/:id` — jwt manage:TenantIdentityProvider — apikey yes — update — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/tenant-idp-config/:id` — jwt manage:TenantIdentityProvider — apikey yes — remove
- `POST /api/v1/admin/tenant-idp-config/:id/test` — jwt manage:TenantIdentityProvider — apikey yes — testConnection
- `PUT /api/v1/admin/tenant-idp-config/:id/directory-credentials` — jwt manage:TenantIdentityProvider — apikey yes — setDirectoryCredentials
- `POST /api/v1/admin/tenant-idp-config/:id/sync` — jwt manage:TenantIdentityProvider — apikey yes — syncDirectory

### TenantSttConfigAdminController

- **File:** `src/modules/tenant-stt-config/tenant-stt-config-admin.controller.ts`
- **Prefix:** `admin/stt-config` → `api/v1/admin/stt-config`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-stt-config:manage`
- **JWT / other:** read/manage:TenantSttConfig
- **Notes:** Effective + row + credentials test.

- `GET /api/v1/admin/stt-config` — jwt read:TenantSttConfig — apikey yes — getEffective
- `GET /api/v1/admin/stt-config/row` — jwt read:TenantSttConfig — apikey yes — getRow
- `PUT /api/v1/admin/stt-config/row` — jwt manage:TenantSttConfig — apikey yes — updateRow — extras: `@RequiresIfMatch`
- `GET /api/v1/admin/stt-config/fallback-candidates` — jwt read:TenantSttConfig — apikey yes — getFallbackCandidates
- `GET /api/v1/admin/stt-config/credentials` — jwt read:TenantSttConfig — apikey yes — getCredentials
- `PUT /api/v1/admin/stt-config/credentials/:provider` — jwt manage:TenantSttConfig — apikey yes — setCredential — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/stt-config/credentials/:provider` — jwt manage:TenantSttConfig — apikey yes — removeCredential
- `POST /api/v1/admin/stt-config/credentials/:provider/test` — jwt manage:TenantSttConfig — apikey yes — testCredential

### WorkflowDefinitionController

- **File:** `src/modules/workflow-definition/workflow-definition.controller.ts`
- **Prefix:** `admin/workflow-definitions` → `api/v1/admin/workflow-definitions`
- **api_count:** 8
- **Auth model:** JWT + API key
- **API key:** `admin:workflow-definition:manage`
- **JWT / other:** manage:WorkflowDefinition
- **Notes:** Validate + publish.

- `POST /api/v1/admin/workflow-definitions` — jwt manage:WorkflowDefinition — apikey yes — create
- `GET /api/v1/admin/workflow-definitions` — jwt manage:WorkflowDefinition — apikey yes — fetchAll
- `GET /api/v1/admin/workflow-definitions/:id` — jwt manage:WorkflowDefinition — apikey yes — fetchById
- `GET /api/v1/admin/workflow-definitions/:id/versions` — jwt manage:WorkflowDefinition — apikey yes — fetchVersions
- `PATCH /api/v1/admin/workflow-definitions/:id` — jwt manage:WorkflowDefinition — update — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/workflow-definitions/:id` — jwt manage:WorkflowDefinition — update — delete
- `POST /api/v1/admin/workflow-definitions/:id/validate` — jwt manage:WorkflowDefinition — update — validate
- `POST /api/v1/admin/workflow-definitions/:id/publish` — jwt manage:WorkflowDefinition — update — publish

### AiModelAdminController

- **File:** `src/modules/ai-model/ai-model-admin.controller.ts`
- **Prefix:** `admin/ai-models` → `api/v1/admin/ai-models`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `admin:ai-model:manage`
- **JWT / other:** manage:all
- **Notes:** Shares prefix with discovery controller.

- `POST /api/v1/admin/ai-models` — jwt manage:all — apikey yes `admin:ai-model:manage` — `create`
- `GET /api/v1/admin/ai-models` — jwt manage:all — apikey yes `admin:ai-model:manage` — `fetchAll`
- `GET /api/v1/admin/ai-models/list` — jwt manage:all — apikey yes `admin:ai-model:manage` — `list`
- `GET /api/v1/admin/ai-models/:id` — jwt manage:all — apikey yes `admin:ai-model:manage` — `fetchById`
- `GET /api/v1/admin/ai-models/slug/:slug` — jwt manage:all — apikey yes `admin:ai-model:manage` — `fetchBySlug`
- `PATCH /api/v1/admin/ai-models/:id` — jwt manage:all — apikey yes `admin:ai-model:manage` — OCC `@RequiresIfMatch` — `update`
- `DELETE /api/v1/admin/ai-models/:id` — jwt manage:all — apikey yes `admin:ai-model:manage` — `delete`

### AuthController

- **File:** `src/modules/auth/auth.controller.ts`
- **Prefix:** `auth` → `api/v1/auth`
- **api_count:** 7
- **Auth model:** Mixed
- **API key:** `forbidden`
- **JWT / other:** class @ForbidApiKey; login+refresh @Public
- **Notes:** Public: POST login, POST refresh. JWT: logout, me, impersonate, stream-ticket, revoke-impersonation.

- `POST /api/v1/auth/login` — public — n/a — throttle 5/min — `login`
- `POST /api/v1/auth/logout` — jwt `@Authorize()` — no ForbidApiKey — `logout`
- `GET /api/v1/auth/me` — jwt `@Authorize()` — no — `me`
- `POST /api/v1/auth/impersonate` — jwt `@Authorize()` — no — throttle 10/min; tenant/role rules in handler — `impersonate`
- `POST /api/v1/auth/refresh` — public — n/a — throttle 60/min — `refresh`
- `POST /api/v1/auth/stream-ticket` — jwt `@Authorize()` — no — `issueStreamTicket`
- `POST /api/v1/auth/revoke-impersonation` — jwt `@Authorize()` — no — `revokeImpersonation`

### BillingAdminController

- **File:** `src/modules/billing/billing-admin.controller.ts`
- **Prefix:** `admin/billing/invoices` → `api/v1/admin/billing/invoices`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `admin:billing:manage`
- **JWT / other:** manage:BillingInvoice
- **Notes:** Mutations SUPER_ADMIN in service.

- `GET /api/v1/admin/billing/invoices/spend-status` — jwt `CanManage(BillingInvoice)` — apikey yes `admin:billing:manage` — `spendStatus`
- `GET /api/v1/admin/billing/invoices` — jwt `CanManage(BillingInvoice)` — apikey yes `admin:billing:manage` — `list`
- `POST /api/v1/admin/billing/invoices/compute-draft` — same + SUPER_ADMIN in service — apikey yes `admin:billing:manage` — `computeDraft`
- `GET /api/v1/admin/billing/invoices/:id` — jwt `CanManage(BillingInvoice)` — apikey yes `admin:billing:manage` — `get`
- `POST /api/v1/admin/billing/invoices/:id/finalize` — same + SUPER_ADMIN — apikey yes `admin:billing:manage` — OCC — `finalize`
- `POST /api/v1/admin/billing/invoices/:id/void` — same + SUPER_ADMIN — apikey yes `admin:billing:manage` — OCC — `void`
- `POST /api/v1/admin/billing/invoices/:id/adjustments` — same + SUPER_ADMIN — apikey yes `admin:billing:manage` — `addAdjustment`

### PoliciesController

- **File:** `src/modules/rbac/policies.controller.ts`
- **Prefix:** `admin/rbac/policies` → `api/v1/admin/rbac/policies`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `admin:rbac-policy:write`
- **JWT / other:** manage:Policy (GETs CanAny read|manage)
- **Notes:** Break-glass on protected deletes.

- `GET /api/v1/admin/rbac/policies` — jwt **`CanAny(read:Policy \| manage:Policy)`** — apikey that scope
- `GET /api/v1/admin/rbac/policies/:id` — jwt **`CanAny(read:Policy \| manage:Policy)`** — apikey same
- `POST /api/v1/admin/rbac/policies` — jwt `manage:Policy` — apikey same
- `PUT /api/v1/admin/rbac/policies/:id` — jwt `manage:Policy` — apikey same — optional break-glass
- `PATCH /api/v1/admin/rbac/policies/:id` — jwt `manage:Policy` — apikey same — optional break-glass
- `DELETE /api/v1/admin/rbac/policies/:id` — jwt `manage:Policy` — apikey same — break-glass body (428/401/400); protected policies 403
- `POST /api/v1/admin/rbac/policies/validate` — jwt `manage:Policy` — apikey same

### TenantTtsConfigAdminController

- **File:** `src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts`
- **Prefix:** `admin/tts-config` → `api/v1/admin/tts-config`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-tts-config:manage`
- **JWT / other:** read/manage:TenantTtsConfig
- **Notes:** Catalog + credentials.

- `GET /api/v1/admin/tts-config` — jwt read:TenantTtsConfig — apikey yes — getEffective
- `GET /api/v1/admin/tts-config/row` — jwt read:TenantTtsConfig — apikey yes — getRow
- `PUT /api/v1/admin/tts-config/row` — jwt manage:TenantTtsConfig — apikey yes — updateRow — extras: `@RequiresIfMatch`
- `GET /api/v1/admin/tts-config/catalog` — jwt read:TenantTtsConfig — apikey yes — getCatalog
- `GET /api/v1/admin/tts-config/credentials` — jwt read:TenantTtsConfig — apikey yes — getCredentials
- `PUT /api/v1/admin/tts-config/credentials/:provider` — jwt manage:TenantTtsConfig — apikey yes — setCredential
- `DELETE /api/v1/admin/tts-config/credentials/:provider` — jwt manage:TenantTtsConfig — apikey yes — removeCredential

### TextProxyController

- **File:** `src/modules/streaming/text-proxy.controller.ts`
- **Prefix:** `text` → `api/v1/text`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `consultation:report:write`
- **JWT / other:** @Authorize()
- **Notes:** Hand-rolled SSE on GET tasks/:taskId/stream (StreamScope text_task).

- `POST /api/v1/text/generate` — jwt (empty `@Authorize()`) — apikey yes — generate
- `GET /api/v1/text/tasks/:taskId` — jwt (empty `@Authorize()`) — apikey yes — getTaskStatus
- `POST /api/v1/text/tasks/:taskId/cancel` — jwt (empty `@Authorize()`) — apikey yes — cancelTask
- `GET /api/v1/text/tasks/:taskId/stream` — jwt (empty `@Authorize()`) — streamTaskEvents — extras: SSE (`text/event-stream`); `@StreamScope({namespace:'text_task'})`; JWT or `?ticket=`
- `POST /api/v1/text/generate/assembled` — jwt (empty `@Authorize()`) — apikey yes — generateAssembled
- `GET /api/v1/text/providers` — jwt (empty `@Authorize()`) — apikey yes — getProviders
- `GET /api/v1/text/guardrail-providers` — jwt (empty `@Authorize()`) — apikey yes — getGuardrailProviders

### WebhookController

- **File:** `src/modules/webhook/webhook.controller.ts`
- **Prefix:** `admin/webhooks` → `api/v1/admin/webhooks`
- **api_count:** 7
- **Auth model:** JWT + API key
- **API key:** `webhook:event:write`
- **JWT / other:** manage:Webhook (deliveries read:WebhookRunHistory)
- **Notes:** Rotate-secret OCC.

- `POST /api/v1/admin/webhooks` — jwt manage:Webhook — apikey yes — create
- `GET /api/v1/admin/webhooks` — jwt manage:Webhook — apikey yes — fetchAll
- `GET /api/v1/admin/webhooks/:id` — jwt manage:Webhook — apikey yes — fetchById
- `GET /api/v1/admin/webhooks/:id/deliveries` — jwt read:WebhookRunHistory (override) — apikey yes — fetchDeliveries
- `PATCH /api/v1/admin/webhooks/:id` — jwt manage:Webhook — apikey yes — update — extras: `@RequiresIfMatch`
- `POST /api/v1/admin/webhooks/:id/rotate-secret` — jwt manage:Webhook — apikey yes — rotateSecret — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/webhooks/:id` — jwt manage:Webhook — apikey yes — delete

### ApiHealthController

- **File:** `src/modules/health/health.controller.ts`
- **Prefix:** `health` → `api/v1/health`
- **api_count:** 6
- **Auth model:** Mixed
- **API key:** `forbidden`
- **JWT / other:** class @ForbidApiKey; services routes CanAny manage:all | read:TenantTelemetry
- **Notes:** Public: /, /live, /ready, /startup. JWT: /services, /services/:key.

- `GET /api/v1/health/live` — public — n/a — `liveness`
- `GET /api/v1/health/ready` — public — n/a — `readiness`
- `GET /api/v1/health/startup` — public — n/a — `startup`
- `GET /api/v1/health` — public — n/a — `check`
- `GET /api/v1/health/services` — jwt `@CanAny([manage,all],[read,TenantTelemetry])` — no ForbidApiKey — `checkServices`
- `GET /api/v1/health/services/:serviceKey` — jwt `@CanAny([manage,all],[read,TenantTelemetry])` — no — `checkServiceByKey`

### AuditLogController

- **File:** `src/modules/audit-log/audit-log.controller.ts`
- **Prefix:** `admin/audit-logs` → `api/v1/admin/audit-logs`
- **api_count:** 6
- **Auth model:** JWT + API key
- **API key:** `admin:audit:read`
- **JWT / other:** read:AuditLog
- **Notes:** Non-SUPER_ADMIN needs tenant context.

- `GET /api/v1/admin/audit-logs` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `fetchAll`
- `GET /api/v1/admin/audit-logs/export` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `exportCsv`
- `GET /api/v1/admin/audit-logs/cursor` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `fetchByCursor`
- `GET /api/v1/admin/audit-logs/:id` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `fetchById`
- `GET /api/v1/admin/audit-logs/resource/:resourceType/:resourceId` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `fetchByResource`
- `GET /api/v1/admin/audit-logs/user/:userId` — jwt `CanRead(AuditLog)` — apikey yes `admin:audit:read` — `fetchByUser`

### ResourceSubscriptionController

- **File:** `src/modules/resource-subscription/resource-subscription.controller.ts`
- **Prefix:** `admin/resource-subscriptions` → `api/v1/admin/resource-subscriptions`
- **api_count:** 6
- **Auth model:** JWT + API key
- **API key:** `admin:resource-subscription:manage`
- **JWT / other:** manage:ResourceSubscription
- **Notes:** Tenant-scoped in service.

- `POST /api/v1/admin/resource-subscriptions` — jwt manage:ResourceSubscription — apikey yes — create
- `GET /api/v1/admin/resource-subscriptions` — jwt manage:ResourceSubscription — apikey yes — fetchAll
- `GET /api/v1/admin/resource-subscriptions/:id` — jwt manage:ResourceSubscription — apikey yes — fetchById
- `PATCH /api/v1/admin/resource-subscriptions/:id` — jwt manage:ResourceSubscription — apikey yes — update
- `POST /api/v1/admin/resource-subscriptions/:id/toggle` — jwt manage:ResourceSubscription — apikey yes — toggle
- `DELETE /api/v1/admin/resource-subscriptions/:id` — jwt manage:ResourceSubscription — apikey yes — delete

### TenantAllowedOriginController

- **File:** `src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts`
- **Prefix:** `admin/allowed-origins` → `api/v1/admin/allowed-origins`
- **api_count:** 6
- **Auth model:** JWT + API key
- **API key:** `admin:allowed-origin:manage`
- **JWT / other:** manage:TenantAllowedOrigin
- **Notes:** Wildcard origins SUPER_ADMIN in service.

- `GET /api/v1/admin/allowed-origins/posture` — jwt manage:TenantAllowedOrigin — apikey yes — getPosture
- `GET /api/v1/admin/allowed-origins` — jwt manage:TenantAllowedOrigin — apikey yes — getAll
- `GET /api/v1/admin/allowed-origins/:id` — jwt manage:TenantAllowedOrigin — apikey yes — getById
- `POST /api/v1/admin/allowed-origins` — jwt manage:TenantAllowedOrigin — create — extras: wildcard/SYSTEM SUPER_ADMIN in service
- `PATCH /api/v1/admin/allowed-origins/:id` — jwt manage:TenantAllowedOrigin — update — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/allowed-origins/:id` — jwt manage:TenantAllowedOrigin — update — deleteById

### TenantStorageConfigAdminController

- **File:** `src/modules/tenant-storage-config/tenant-storage-config-admin.controller.ts`
- **Prefix:** `admin/tenants/storage/config` → `api/v1/admin/tenants/storage/config`
- **api_count:** 6
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-storage:manage`
- **JWT / other:** manage|update:Tenant; methods Can*:Storage
- **Notes:** Platform default routes SUPER_ADMIN in service.

- `GET /api/v1/admin/tenants/storage/config` — jwt read:Storage — apikey yes — listConfigs
- `GET /api/v1/admin/tenants/storage/config/platform` — jwt read:Storage — apikey yes — getPlatformDefault — extras: SUPER_ADMIN in service
- `PUT /api/v1/admin/tenants/storage/config/platform` — jwt update:Storage — apikey yes — upsertPlatformDefault — extras: `@RequiresIfMatch`; SUPER_ADMIN in service
- `GET /api/v1/admin/tenants/storage/config/effective` — jwt read:Storage — apikey yes — getEffectiveConfig
- `PUT /api/v1/admin/tenants/storage/config` — jwt update:Storage — apikey yes — upsertConfig
- `DELETE /api/v1/admin/tenants/storage/config/:id` — jwt delete:Storage — apikey yes — deleteConfig — extras: TenantOwnedResource

### AiInferenceController

- **File:** `src/modules/ai-inference/ai-inference.controller.ts`
- **Prefix:** `ai` → `api/v1/ai`
- **api_count:** 5
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize()
- **Notes:** Guardrail + NLP proxy.

- `POST /api/v1/ai/guardrail/analyze` — jwt `@Authorize()` — apikey no ForbidApiKey — `analyzeGuardrail`
- `POST /api/v1/ai/nlp/entities` — jwt `@Authorize()` — apikey no ForbidApiKey — `extractEntities`
- `POST /api/v1/ai/nlp/diagnosis` — jwt `@Authorize()` — apikey no ForbidApiKey — `suggestDiagnosis`
- `POST /api/v1/ai/nlp/topic` — jwt `@Authorize()` — apikey no ForbidApiKey — `classifyTopic`
- `POST /api/v1/ai/nlp/intent` — jwt `@Authorize()` — apikey no ForbidApiKey — `classifyIntent`

### AiRuntimeProfileController

- **File:** `src/modules/ai-runtime-profile/ai-runtime-profile.controller.ts`
- **Prefix:** `admin/ai-runtime-profiles` → `api/v1/admin/ai-runtime-profiles`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `admin:ai-runtime-profile:manage`
- **JWT / other:** manage:all
- **Notes:** SUPER_ADMIN / SYSTEM rows.

- `GET /api/v1/admin/ai-runtime-profiles` — jwt manage:all — apikey yes `admin:ai-runtime-profile:manage` — `list`
- `GET /api/v1/admin/ai-runtime-profiles/row` — jwt manage:all — apikey yes `admin:ai-runtime-profile:manage` — `getRow`
- `GET /api/v1/admin/ai-runtime-profiles/resolve` — jwt manage:all — apikey yes `admin:ai-runtime-profile:manage` — `resolve`
- `PUT /api/v1/admin/ai-runtime-profiles/row` — jwt manage:all — apikey yes `admin:ai-runtime-profile:manage` — OCC — `upsert`
- `DELETE /api/v1/admin/ai-runtime-profiles/row` — jwt manage:all — apikey yes `admin:ai-runtime-profile:manage` — `remove`

### AuthSsoController

- **File:** `src/modules/auth/auth-sso.controller.ts`
- **Prefix:** `auth/sso` → `api/v1/auth/sso`
- **api_count:** 5
- **Auth model:** Public
- **API key:** `n/a`
- **JWT / other:** none (@Public)
- **Notes:** OIDC + SAML start/callback/ACS. Throttled.

- `POST /api/v1/auth/sso/start` — public — apikey n/a — throttle 5/min — `start`
- `GET /api/v1/auth/sso/callback` — public — n/a — throttle 10/min — `callback`
- `GET /api/v1/auth/sso/saml/:tenantKey/metadata` — public — n/a — `samlMetadata`
- `POST /api/v1/auth/sso/saml/:tenantKey/start` — public — n/a — throttle 5/min — `samlStart`
- `POST /api/v1/auth/sso/saml/:tenantKey/acs` — public — n/a — throttle 10/min — `samlAcs`

### KnowledgeController

- **File:** `src/modules/knowledge/knowledge.controller.ts`
- **Prefix:** `admin/knowledge/documents` → `api/v1/admin/knowledge/documents`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `admin:knowledge:manage`
- **JWT / other:** manage:KnowledgeDocument (chunks → read)
- **Notes:** Qdrant cleanup fail-closed on delete.

- `GET /api/v1/admin/knowledge/documents` — jwt `manage:KnowledgeDocument` — apikey `admin:knowledge:manage` — tenant CLS
- `GET /api/v1/admin/knowledge/documents/:id` — jwt `manage:KnowledgeDocument` — apikey same — 404-over-403
- `GET /api/v1/admin/knowledge/documents/:id/chunks` — jwt **`read:KnowledgeDocument` (overrides class manage)** — apikey same — force-audited chunk text
- `POST /api/v1/admin/knowledge/documents/:id/archive` — jwt `manage:KnowledgeDocument` — apikey same
- `DELETE /api/v1/admin/knowledge/documents/:id` — jwt `manage:KnowledgeDocument` — apikey same — Qdrant cleanup fail-closed

### McpAdminController

- **File:** `src/modules/mcp-admin/mcp-admin.controller.ts`
- **Prefix:** `admin/mcp-servers` → `api/v1/admin/mcp-servers`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `admin:mcp-server:manage`
- **JWT / other:** read/manage:McpServer
- **Notes:** Writes SUPER_ADMIN-only in service.

- `GET /api/v1/admin/mcp-servers` — jwt `read:McpServer` — apikey `admin:mcp-server:manage` — `?tenantId=` super-admin only
- `GET /api/v1/admin/mcp-servers/:id` — jwt `read:McpServer` — apikey same
- `POST /api/v1/admin/mcp-servers` — jwt `manage:McpServer` — apikey same — **SUPER_ADMIN-only in service (403)**
- `PATCH /api/v1/admin/mcp-servers/:id` — jwt `manage:McpServer` — apikey same — `@RequiresIfMatch` OCC; SUPER_ADMIN-only
- `DELETE /api/v1/admin/mcp-servers/:id` — jwt `manage:McpServer` — apikey same — `@RequiresIfMatch`; SUPER_ADMIN-only

### PromptTemplateController

- **File:** `src/modules/prompt-management/prompt-template.controller.ts`
- **Prefix:** `prompt-templates` → `api/v1/prompt-templates`
- **api_count:** 5
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** read:PromptTemplate (writes owner-gated in service)
- **Notes:** Clinician plane — AUTH-NOTE: declared read, ownership in service.

- `GET /api/v1/prompt-templates/available` — jwt `read:PromptTemplate` — apikey **forbidden**
- `PUT /api/v1/prompt-templates/preferred` — jwt `read:PromptTemplate` — apikey forbidden
- `POST /api/v1/prompt-templates` — jwt `read:PromptTemplate` — apikey forbidden — personal create; owner-gated
- `PATCH /api/v1/prompt-templates/:id` — jwt `read:PromptTemplate` — apikey forbidden — `@RequiresIfMatch`; owner-gated
- `DELETE /api/v1/prompt-templates/:id` — jwt `read:PromptTemplate` — apikey forbidden — owner-gated

### SchedulerAdminController

- **File:** `src/modules/queue-admin/scheduler-admin.controller.ts`
- **Prefix:** `admin/schedulers` → `api/v1/admin/schedulers`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `admin:scheduler:manage`
- **JWT / other:** manage:all
- **Notes:** Pause/resume/cron/toggle.

- `GET /api/v1/admin/schedulers` — jwt manage:all — apikey yes — listSchedulers
- `POST /api/v1/admin/schedulers/:name/pause` — jwt manage:all — apikey yes — pauseScheduler
- `POST /api/v1/admin/schedulers/:name/resume` — jwt manage:all — apikey yes — resumeScheduler
- `PATCH /api/v1/admin/schedulers/:name/cron` — jwt manage:all — apikey yes — updateCron
- `PATCH /api/v1/admin/schedulers/:name/toggle` — jwt manage:all — apikey yes — toggleScheduler

### VoiceProfileController

- **File:** `src/modules/voice-profile/voice-profile.controller.ts`
- **Prefix:** `voice-profile` → `api/v1/voice-profile`
- **api_count:** 5
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** per-verb UserVoiceProfile
- **Notes:** TenantOwnedResource on mutate/delete.

- `POST /api/v1/voice-profile/enroll` — jwt create:UserVoiceProfile — apikey no — enroll
- `GET /api/v1/voice-profile` — jwt read:UserVoiceProfile — apikey no — list
- `PATCH /api/v1/voice-profile/:id/activate` — jwt update:UserVoiceProfile — apikey no — activate — extras: TenantOwnedResource
- `PATCH /api/v1/voice-profile/:id/deactivate` — jwt update:UserVoiceProfile — apikey no — deactivate — extras: TenantOwnedResource
- `DELETE /api/v1/voice-profile/:id` — jwt delete:UserVoiceProfile — apikey no — deleteById — extras: TenantOwnedResource

### WorkflowTestFixtureController

- **File:** `src/modules/workflow-test-fixture/workflow-test-fixture.controller.ts`
- **Prefix:** `admin/workflow-test-fixtures` → `api/v1/admin/workflow-test-fixtures`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `admin:workflow-test-fixture:manage`
- **JWT / other:** manage:WorkflowTestFixture

- `POST /api/v1/admin/workflow-test-fixtures` — jwt manage:WorkflowTestFixture — apikey yes — create
- `GET /api/v1/admin/workflow-test-fixtures` — jwt manage:WorkflowTestFixture — apikey yes — fetchAll
- `GET /api/v1/admin/workflow-test-fixtures/:id` — jwt manage:WorkflowTestFixture — apikey yes — fetchById
- `PATCH /api/v1/admin/workflow-test-fixtures/:id` — jwt manage:WorkflowTestFixture — update — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/workflow-test-fixtures/:id` — jwt manage:WorkflowTestFixture — update — delete

### WorkflowsController

- **File:** `src/modules/workflows/workflows.controller.ts`
- **Prefix:** `workflows` → `api/v1/workflows`
- **api_count:** 5
- **Auth model:** JWT + API key
- **API key:** `workflow:definition:read / workflow:run:read|write`
- **JWT / other:** per-route WorkflowDefinition / WorkflowRun
- **Notes:** Hand-rolled SSE on run stream. Heavy throttle on invoke.

- `GET /api/v1/workflows` — jwt list:WorkflowDefinition — apikey yes (`workflow:definition:read`) — list
- `POST /api/v1/workflows/:slug/invoke` — jwt create:WorkflowRun — apikey yes (`workflow:run:write`) — invoke — extras: `@Throttle({heavy})`; Idempotency-Key
- `GET /api/v1/workflows/:slug/runs/:runId` — jwt read:WorkflowRun — apikey yes (`workflow:run:read`) — getRunStatus
- `POST /api/v1/workflows/:slug/runs/:runId/cancel` — jwt update:WorkflowRun — apikey yes (`workflow:run:write`) — cancelRun
- `GET /api/v1/workflows/:slug/runs/:runId/stream` — jwt read:WorkflowRun — apikey yes (`workflow:run:read`) — streamRunStatus — extras: SSE `@Res()`; StreamScope JWT or ticket

### AdminUsageController

- **File:** `src/modules/admin-usage/admin-usage.controller.ts`
- **Prefix:** `admin/usage` → `api/v1/admin/usage`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:usage:manage`
- **JWT / other:** manage:UsageAnalytics
- **Notes:** top-tenants SUPER_ADMIN in service.

- `GET /api/v1/admin/usage/summary` — jwt manage UsageAnalytics — apikey yes `admin:usage:manage` — `summary`
- `GET /api/v1/admin/usage/timeseries` — jwt manage UsageAnalytics — apikey yes `admin:usage:manage` — `timeseries`
- `GET /api/v1/admin/usage/cost-per-encounter` — jwt manage UsageAnalytics — apikey yes `admin:usage:manage` — `costPerEncounter`
- `GET /api/v1/admin/usage/top-tenants` — same + SUPER_ADMIN in service — apikey yes `admin:usage:manage` — `topTenants`

### AiProviderConnectionController

- **File:** `src/modules/ai-provider-connection/ai-provider-connection.controller.ts`
- **Prefix:** `admin/ai-providers` → `api/v1/admin/ai-providers`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:ai-provider:manage`
- **JWT / other:** read/manage:GlobalSetting
- **Notes:** Legacy LLM alias (service=llm).

- `GET /api/v1/admin/ai-providers` — jwt `CanRead(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `list`
- `GET /api/v1/admin/ai-providers/:provider` — jwt `CanRead(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `getOne`
- `PUT /api/v1/admin/ai-providers/:provider` — jwt `CanManage(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — OCC — `upsert`
- `DELETE /api/v1/admin/ai-providers/:provider` — jwt `CanManage(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `remove`

### AiTaskDefaultAdminController

- **File:** `src/modules/ai-task-default/ai-task-default-admin.controller.ts`
- **Prefix:** `admin/ai-task-defaults` → `api/v1/admin/ai-task-defaults`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:ai-task-default:manage`
- **JWT / other:** read/manage:AiTaskDefault
- **Notes:** Some keys SUPER_ADMIN in service.

- `GET /api/v1/admin/ai-task-defaults/options` — jwt `CanRead(AiTaskDefault)` — apikey yes `admin:ai-task-default:manage` — `getOptions`
- `GET /api/v1/admin/ai-task-defaults` — jwt `CanRead(AiTaskDefault)` — apikey yes `admin:ai-task-default:manage` — `getEffective`
- `GET /api/v1/admin/ai-task-defaults/row` — jwt `CanRead(AiTaskDefault)` — apikey yes `admin:ai-task-default:manage` — `getRow`
- `PUT /api/v1/admin/ai-task-defaults/row` — jwt `CanManage(AiTaskDefault)` — apikey yes `admin:ai-task-default:manage` — OCC — `upsertRow`

### MonitoringController

- **File:** `src/modules/monitoring/monitoring.controller.ts`
- **Prefix:** `monitoring` → `api/v1/monitoring`
- **api_count:** 4
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** CanAny manage:all | read:TenantTelemetry
- **Notes:** Not under /admin. Throttle 300/60s.

- `GET /api/v1/monitoring/uptime` — jwt CanAny — apikey **forbidden** — throttle
- `GET /api/v1/monitoring/uptime/:service` — jwt CanAny — apikey forbidden — throttle
- `GET /api/v1/monitoring/heartbeats/:service` — jwt CanAny — apikey forbidden — throttle
- `GET /api/v1/monitoring/sessions` — jwt CanAny — apikey forbidden — throttle

### NotificationController

- **File:** `src/modules/notification/notification.controller.ts`
- **Prefix:** `admin/notifications` → `api/v1/admin/notifications`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:notification:manage`
- **JWT / other:** manage:Notification
- **Notes:** No create route.

- `GET /api/v1/admin/notifications` — jwt `manage:Notification` — apikey `admin:notification:manage` — optional `?tenantId=` SUPER_ADMIN
- `GET /api/v1/admin/notifications/:id` — jwt `manage:Notification` — apikey same — 404-over-403
- `PATCH /api/v1/admin/notifications/:id` — jwt `manage:Notification` — apikey same — no If-Match
- `DELETE /api/v1/admin/notifications/:id` — jwt `manage:Notification` — apikey same

### ProviderConnectionController

- **File:** `src/modules/ai-provider-connection/ai-provider-connection.controller.ts`
- **Prefix:** `admin/providers` → `api/v1/admin/providers`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:ai-provider:manage`
- **JWT / other:** read/manage:GlobalSetting
- **Notes:** Same file as AiProviderConnectionController.

- `GET /api/v1/admin/providers/:service` — jwt `CanRead(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `list`
- `GET /api/v1/admin/providers/:service/:provider` — jwt `CanRead(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `getOne`
- `PUT /api/v1/admin/providers/:service/:provider` — jwt `CanManage(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — OCC — `upsert`
- `DELETE /api/v1/admin/providers/:service/:provider` — jwt `CanManage(GlobalSetting)` — apikey yes `admin:ai-provider:manage` — `remove`

### RateLimitAdminController

- **File:** `src/modules/admin-rate-limit/rate-limit-admin.controller.ts`
- **Prefix:** `admin/rate-limit` → `api/v1/admin/rate-limit`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:rate-limit:manage`
- **JWT / other:** manage:all
- **Notes:** SUPER_ADMIN policy editor.

- `GET /api/v1/admin/rate-limit` — jwt manage:all — apikey yes — getPolicy
- `PUT /api/v1/admin/rate-limit/enabled` — jwt manage:all — apikey yes — setEnabled
- `PUT /api/v1/admin/rate-limit/tiers/:tier` — jwt manage:all — apikey yes — setTier
- `PUT /api/v1/admin/rate-limit/routes/:routeId` — jwt manage:all — apikey yes — setRoute

### UserDepartmentsController

- **File:** `src/modules/user/controllers/user-departments.controller.ts`
- **Prefix:** `admin/users` → `api/v1/admin/users`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:user:write`
- **JWT / other:** manage:User
- **Notes:** :id/departments assign/unassign.

- `GET /api/v1/admin/users/:id/departments` — jwt manage:User — apikey yes — list
- `POST /api/v1/admin/users/:id/departments` — jwt manage:User — apikey yes — assign
- `PATCH /api/v1/admin/users/:id/departments/:assignmentId` — jwt manage:User — apikey yes — update — extras: `@RequiresIfMatch`
- `DELETE /api/v1/admin/users/:id/departments/:assignmentId` — jwt manage:User — apikey yes — unassign

### WorkflowSandboxRunController

- **File:** `src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts`
- **Prefix:** `admin/workflow-definitions/:definitionId/sandbox-runs` → `api/v1/admin/workflow-definitions/:definitionId/sandbox-runs`
- **api_count:** 4
- **Auth model:** JWT + API key
- **API key:** `admin:workflow-definition:manage`
- **JWT / other:** per-method WorkflowRun Can*
- **Notes:** Hand-rolled SSE + StreamScope workflow_run.

- `POST /api/v1/admin/workflow-definitions/:definitionId/sandbox-runs` — jwt create:WorkflowRun — apikey yes — start
- `GET /api/v1/admin/workflow-definitions/:definitionId/sandbox-runs/:runId` — jwt read:WorkflowRun — apikey yes — getStatus
- `POST /api/v1/admin/workflow-definitions/:definitionId/sandbox-runs/:runId/cancel` — jwt update:WorkflowRun — apikey yes — cancel
- `GET /api/v1/admin/workflow-definitions/:definitionId/sandbox-runs/:runId/stream` — jwt read:WorkflowRun — apikey yes — stream — extras: SSE via `@Res()`; `@StreamScope({namespace:'workflow_run'})`

### AdminConsultationController

- **File:** `src/modules/consultation/admin-consultation.controller.ts`
- **Prefix:** `admin/consultations` → `api/v1/admin/consultations`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:consultation-admin:manage`
- **JWT / other:** manage:Consultation
- **Notes:** Tenant-wide list/aggregate.

- `GET /api/v1/admin/consultations` — jwt `CanManage(Consultation)` — apikey yes `admin:consultation-admin:manage` — `list`
- `GET /api/v1/admin/consultations/aggregate` — jwt `CanManage(Consultation)` — apikey yes `admin:consultation-admin:manage` — `aggregate`
- `GET /api/v1/admin/consultations/:id` — jwt `CanManage(Consultation)` — apikey yes `admin:consultation-admin:manage` — `getById`

### AdminReconciliationController

- **File:** `src/modules/admin-usage/admin-reconciliation.controller.ts`
- **Prefix:** `admin/usage/reconciliation` → `api/v1/admin/usage/reconciliation`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:usage:manage`
- **JWT / other:** manage:UsageAnalytics

- `GET /api/v1/admin/usage/reconciliation/runs` — jwt `CanManage(UsageAnalytics)` — apikey yes `admin:usage:manage` — `runs`
- `POST /api/v1/admin/usage/reconciliation/run` — jwt `CanManage(UsageAnalytics)` — apikey yes `admin:usage:manage` — `run`
- `GET /api/v1/admin/usage/reconciliation/latest` — jwt `CanManage(UsageAnalytics)` — apikey yes `admin:usage:manage` — `latest`

### AdminTranscriptionJobController

- **File:** `src/modules/streaming/admin-transcription-job.controller.ts`
- **Prefix:** `admin/audio/transcription-jobs` → `api/v1/admin/audio/transcription-jobs`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:transcription-job:read`
- **JWT / other:** class manage:Tenant; handlers read:AsrPipeline

- `GET /api/v1/admin/audio/transcription-jobs` — jwt `CanRead(AsrPipeline)` — apikey yes `admin:transcription-job:read` — `list`
- `GET /api/v1/admin/audio/transcription-jobs/stats` — jwt `CanRead(AsrPipeline)` — apikey yes `admin:transcription-job:read` — `getStats`
- `GET /api/v1/admin/audio/transcription-jobs/status/:status` — jwt `CanRead(AsrPipeline)` — apikey yes `admin:transcription-job:read` — `getByStatus`

### AgentPromotionController

- **File:** `src/modules/agent-promotion/agent-promotion.controller.ts`
- **Prefix:** `admin/agent-promotions` → `api/v1/admin/agent-promotions`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:agent-promotion:manage`
- **JWT / other:** manage:DepartmentAgent
- **Notes:** POST requires manage in both tenants (service).

- `POST /api/v1/admin/agent-promotions` — jwt manage DepartmentAgent + dual-tenant in service — apikey yes `admin:agent-promotion:manage` — `promote`
- `GET /api/v1/admin/agent-promotions` — jwt manage DepartmentAgent — apikey yes `admin:agent-promotion:manage` — `list`
- `GET /api/v1/admin/agent-promotions/:id` — jwt manage DepartmentAgent — apikey yes `admin:agent-promotion:manage` — `getById`

### AgentTrajectoryController

- **File:** `src/modules/agent-trajectory/agent-trajectory.controller.ts`
- **Prefix:** `admin/agent-trajectory` → `api/v1/admin/agent-trajectory`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:agent-trajectory:read`
- **JWT / other:** read:AgentTrajectory

- `GET /api/v1/admin/agent-trajectory/metrics/generation` — jwt `CanRead(AgentTrajectory)` — apikey yes `admin:agent-trajectory:read` — `aggregateGenerationStats`
- `GET /api/v1/admin/agent-trajectory/sessions` — jwt `CanRead(AgentTrajectory)` — apikey yes `admin:agent-trajectory:read` — `listSessions`
- `GET /api/v1/admin/agent-trajectory/sessions/:sessionId/steps` — jwt `CanRead(AgentTrajectory)` — apikey yes `admin:agent-trajectory:read` — `listSteps`

### AiServiceAdminController

- **File:** `src/modules/ai-service-admin/ai-service-admin.controller.ts`
- **Prefix:** `admin/ai-services` → `api/v1/admin/ai-services`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:ai-service:manage`
- **JWT / other:** manage:all
- **Notes:** Read-only guardrail/NLP status proxy.

- `GET /api/v1/admin/ai-services/guardrail/status` — jwt manage:all — apikey yes `admin:ai-service:manage` — `guardrailStatus`
- `GET /api/v1/admin/ai-services/guardrail/config` — jwt manage:all — apikey yes `admin:ai-service:manage` — `guardrailConfig`
- `GET /api/v1/admin/ai-services/nlp/status` — jwt manage:all — apikey yes `admin:ai-service:manage` — `nlpStatus`

### AudioPipelinePublicController

- **File:** `src/modules/pipeline/audio-pipeline-public.controller.ts`
- **Prefix:** `audio/pipelines` → `api/v1/audio/pipelines`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize()
- **Notes:** Read-only catalog for clinicians.

- `GET /api/v1/audio/pipelines` — jwt `@Authorize()` — apikey no ForbidApiKey — `fetchAll`
- `GET /api/v1/audio/pipelines/:id` — jwt `@Authorize()` — no — `fetchById`
- `GET /api/v1/audio/pipelines/slug/:slug` — jwt `@Authorize()` — no — `fetchBySlug`

### ChangelogAdminController

- **File:** `src/modules/changelog/changelog-admin.controller.ts`
- **Prefix:** `admin/changelog` → `api/v1/admin/changelog`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:changelog:manage`
- **JWT / other:** manage:ChangelogEntry
- **Notes:** SUPER_ADMIN in service.

- `POST /api/v1/admin/changelog` — jwt `CanManage(ChangelogEntry)` + SUPER_ADMIN in service — apikey yes `admin:changelog:manage` — `create`
- `PATCH /api/v1/admin/changelog/:id` — jwt `CanManage(ChangelogEntry)` + SUPER_ADMIN in service — apikey yes `admin:changelog:manage` — OCC — `update`
- `POST /api/v1/admin/changelog/:id/publish` — jwt `CanManage(ChangelogEntry)` + SUPER_ADMIN in service — apikey yes `admin:changelog:manage` — OCC — `publish`

### ChangelogController

- **File:** `src/modules/changelog/changelog.controller.ts`
- **Prefix:** `changelog` → `api/v1/changelog`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize() (any authenticated user)
- **Notes:** Reader plane.

- `GET /api/v1/changelog` — jwt `@Authorize()` — apikey no ForbidApiKey — `list`
- `GET /api/v1/changelog/unseen` — jwt `@Authorize()` — apikey no ForbidApiKey — `listUnseen`
- `POST /api/v1/changelog/acknowledge` — jwt `@Authorize()` — apikey no ForbidApiKey — `acknowledge`

### ConsentGrantController

- **File:** `src/modules/consent/consent.controller.ts`
- **Prefix:** `admin/consent-grants` → `api/v1/admin/consent-grants`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** manage:ConsentGrant
- **Notes:** Human-only consent admin. `@ForbidApiKey()`.

- `POST /api/v1/admin/consent-grants` — jwt `CanManage(ConsentGrant)` — apikey no ForbidApiKey — `create`
- `GET /api/v1/admin/consent-grants` — jwt `CanManage(ConsentGrant)` — apikey no ForbidApiKey — `getByPatient`
- `PATCH /api/v1/admin/consent-grants/:id/revoke` — jwt `CanManage(ConsentGrant)` — apikey no ForbidApiKey — OCC — `revoke`

### ConsultationJobController

- **File:** `src/modules/consultation/consultation-job.controller.ts`
- **Prefix:** `consultations/jobs` → `api/v1/consultations/jobs`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `consultation:session:read`
- **JWT / other:** @Authorize()
- **Notes:** 1 SSE + TenantOwnedResource.

- `GET /api/v1/consultations/jobs/:jobId` — jwt `@Authorize()` — apikey yes `consultation:session:read` — `@TenantOwnedResource(ConsultationJob)` — `getJob`
- `PATCH /api/v1/consultations/jobs/:jobId/cancel` — jwt `@Authorize()` — apikey yes `consultation:session:read` — TenantOwnedResource `scope:creator` — `cancelJob`
- `GET /api/v1/consultations/jobs/:jobId/stream` — SSE — apikey yes `consultation:session:read` — same + `@StreamScope(consultation_job)` — `streamJob`

### MyBillingController

- **File:** `src/modules/billing/my-billing.controller.ts`
- **Prefix:** `billing` → `api/v1/billing`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** read:Tenant
- **Notes:** CLS tenant only. 404-over-403 on foreign invoice.

- `GET /api/v1/billing/me/invoices` — jwt `read:Tenant` — apikey **forbidden** — CLS tenant
- `GET /api/v1/billing/me/invoices/:id` — jwt `read:Tenant` — apikey forbidden — 404-over-403
- `GET /api/v1/billing/me/spend` — jwt `read:Tenant` — apikey forbidden — optional `?period=`

### MyTenantController

- **File:** `src/modules/tenant/my-tenant.controller.ts`
- **Prefix:** `tenant` → `api/v1/tenant`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize(); PATCH update:Tenant

- `GET /api/v1/tenant/me` — jwt authenticated — apikey **forbidden** — CLS tenant
- `GET /api/v1/tenant/me/config` — jwt authenticated — apikey forbidden — appends synthetic `enable-local-raw-capture`
- `PATCH /api/v1/tenant/me/config` — jwt **`update:Tenant`** — apikey forbidden — `@RequiresIfMatch` OCC

### PermissionCheckController

- **File:** `src/modules/rbac/permission-check.controller.ts`
- **Prefix:** `rbac/check` → `api/v1/rbac/check`
- **api_count:** 3
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize(); other-user checks need manage:User

- `POST /api/v1/rbac/check` — jwt authenticated — apikey **forbidden** — checking another `userId` requires `manage:User` (imperative)
- `POST /api/v1/rbac/check/bulk` — jwt authenticated — apikey forbidden — same other-user gate
- `POST /api/v1/rbac/check/my-permissions` — jwt authenticated — apikey forbidden

### PipelinePolicyAdminController

- **File:** `src/modules/pipeline-policy-admin/pipeline-policy-admin.controller.ts`
- **Prefix:** `admin/harness/pipeline-policy` → `api/v1/admin/harness/pipeline-policy`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:pipeline-policy:manage`
- **JWT / other:** read/manage:PipelinePolicy

- `GET /api/v1/admin/harness/pipeline-policy` — jwt `read:PipelinePolicy` — apikey that scope — effective cascade; tenant pin / `?tenantId=`
- `GET /api/v1/admin/harness/pipeline-policy/row` — jwt `read:PipelinePolicy` — apikey same — raw row / placeholder v0
- `PUT /api/v1/admin/harness/pipeline-policy/row` — jwt `manage:PipelinePolicy` — apikey same — `@RequiresIfMatch`; WORM change log

### PlatformMetricsController

- **File:** `src/modules/platform-metrics/platform-metrics.controller.ts`
- **Prefix:** `admin/platform` → `api/v1/admin/platform`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:platform-metrics:read`
- **JWT / other:** manage:PlatformMetrics
- **Notes:** SUPER_ADMIN via manage:all.

- `GET /api/v1/admin/platform/metrics` — jwt `manage:PlatformMetrics` — apikey `admin:platform-metrics:read`
- `GET /api/v1/admin/platform/sockets` — jwt `manage:PlatformMetrics` — apikey same
- `GET /api/v1/admin/platform/consumption` — jwt `manage:PlatformMetrics` — apikey same — optional `?tenantId=`

### RateCardAdminController

- **File:** `src/modules/billing/rate-card-admin.controller.ts`
- **Prefix:** `admin/billing/rate-card` → `api/v1/admin/billing/rate-card`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:billing:manage`
- **JWT / other:** manage:AiPriceBook
- **Notes:** Mutations SUPER_ADMIN in service.

- `GET /api/v1/admin/billing/rate-card` — jwt manage:AiPriceBook — apikey yes — list
- `POST /api/v1/admin/billing/rate-card` — jwt manage:AiPriceBook — create — extras: SUPER_ADMIN in service
- `POST /api/v1/admin/billing/rate-card/:id/supersede` — jwt manage:AiPriceBook — supersede — extras: `@RequiresIfMatch`; SUPER_ADMIN in service

### ServiceReleaseAdminController

- **File:** `src/modules/service-release/service-release-admin.controller.ts`
- **Prefix:** `admin/service-releases` → `api/v1/admin/service-releases`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:service-release:manage`
- **JWT / other:** CanAny manage:all | read:TenantTelemetry

- `GET /api/v1/admin/service-releases` — jwt manage:all OR read:TenantTelemetry — apikey yes — list
- `GET /api/v1/admin/service-releases/current` — jwt manage:all OR read:TenantTelemetry — apikey yes — current
- `GET /api/v1/admin/service-releases/:serviceName/history` — jwt manage:all OR read:TenantTelemetry — apikey yes — history

### StorageAccessKeyController

- **File:** `src/modules/storage-access-key/storage-access-key.controller.ts`
- **Prefix:** `admin/tenants/storage/keys` → `api/v1/admin/tenants/storage/keys`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:storage-key:manage`
- **JWT / other:** class manage:Tenant; methods Can*:Storage

- `GET /api/v1/admin/tenants/storage/keys` — jwt read:Storage — apikey yes — listKeys
- `POST /api/v1/admin/tenants/storage/keys` — jwt create:Storage — apikey yes — generateKey
- `DELETE /api/v1/admin/tenants/storage/keys/:id` — jwt delete:Storage — apikey yes — revokeKey

### SttCompatController

- **File:** `src/modules/stt-compat/stt-compat.controller.ts`
- **Prefix:** `api/stt (prefix excluded)` → `api/stt (prefix excluded)`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `stt:stream:write`
- **JWT / other:** @Authorize()
- **Notes:** Live paths: POST /api/stt/{start_session,switch,stop_session}.

- `POST /api/stt/start_session` — jwt (empty `@Authorize()`) — apikey yes — startSession
- `POST /api/stt/switch` — jwt (empty `@Authorize()`) — apikey yes — switchSession
- `POST /api/stt/stop_session` — jwt (empty `@Authorize()`) — apikey yes — stopSession — extras: FileInterceptor

### WorkflowRunController

- **File:** `src/modules/workflow-run/workflow-run.controller.ts`
- **Prefix:** `admin/workflow-runs` → `api/v1/admin/workflow-runs`
- **api_count:** 3
- **Auth model:** JWT + API key
- **API key:** `admin:workflow-run:read`
- **JWT / other:** read:WorkflowRun
- **Notes:** Working-tenant CLS required.

- `GET /api/v1/admin/workflow-runs` — jwt read:WorkflowRun — apikey yes — listRuns — extras: working-tenant required
- `GET /api/v1/admin/workflow-runs/:runId` — jwt read:WorkflowRun — apikey yes — getRun
- `GET /api/v1/admin/workflow-runs/:runId/trace` — jwt read:WorkflowRun — apikey yes — getRunTrace

### AiModelDiscoveryController

- **File:** `src/modules/ai-model/ai-model-discovery.controller.ts`
- **Prefix:** `admin/ai-models` → `api/v1/admin/ai-models`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:ai-model:manage`
- **JWT / other:** manage:all

- `GET /api/v1/admin/ai-models/discovery` — jwt manage:all — apikey yes `admin:ai-model:manage` — `discover`
- `POST /api/v1/admin/ai-models/discovery/register` — jwt manage:all — apikey yes `admin:ai-model:manage` — `register`

### MyUsageController

- **File:** `src/modules/admin-usage/my-usage.controller.ts`
- **Prefix:** `usage` → `api/v1/usage`
- **api_count:** 2
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** read:Tenant
- **Notes:** No tenantId override.

- `GET /api/v1/usage/me/summary` — jwt `read:Tenant` — apikey **forbidden** — CLS tenant (no override)
- `GET /api/v1/usage/me/burndown` — jwt `read:Tenant` — apikey forbidden — CLS tenant

### NlpTaskInstructionsAdminController

- **File:** `src/modules/nlp-task-instructions/nlp-task-instructions-admin.controller.ts`
- **Prefix:** `admin/nlp-task-instructions` → `api/v1/admin/nlp-task-instructions`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:nlp-task-instructions:manage`
- **JWT / other:** read/manage:TenantNlpTaskInstructions
- **Notes:** No class @Authorize; per-handler CASL.

- `GET /api/v1/admin/nlp-task-instructions/row` — jwt `read:TenantNlpTaskInstructions` — apikey that scope — `?taskKey=` required; `?tenantId=` super-admin
- `PUT /api/v1/admin/nlp-task-instructions/row` — jwt `manage:TenantNlpTaskInstructions` — apikey same — `@RequiresIfMatch`

### PrismaStudioController

- **File:** `src/modules/pstudio/pstudio.controller.ts`
- **Prefix:** `admin/pstudio` → `api/v1/admin/pstudio`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:pstudio:manage`
- **JWT / other:** manage:PrismaStudio
- **Notes:** HTML shell + BFF POST. Not public.

- `GET /api/v1/admin/pstudio` — jwt `manage:PrismaStudio` — apikey that scope — HTML shell (`@ApiExcludeEndpoint`); no-store
- `POST /api/v1/admin/pstudio` — jwt `manage:PrismaStudio` — apikey same — Studio query/sequence BFF; audited

### RegisterController

- **File:** `src/modules/auth/register.controller.ts`
- **Prefix:** `auth` → `api/v1/auth`
- **api_count:** 2
- **Auth model:** Public
- **API key:** `n/a`
- **JWT / other:** none
- **Notes:** 404 if self-signup flag off. Throttled.

- `POST /api/v1/auth/register` — public — apikey no — register — extras: `@Throttle` 5/60s; feature flag
- `POST /api/v1/auth/register/verify` — public — apikey no — verify — extras: `@Throttle` 10/60s

### ServiceReleaseInternalController

- **File:** `src/modules/service-release/service-release-internal.controller.ts`
- **Prefix:** `internal/service-releases` → `api/v1/internal/service-releases`
- **api_count:** 2
- **Auth model:** Service token
- **API key:** `n/a — X-Service-Token (any known service secret)`
- **JWT / other:** skipped (@Public)

- `POST /api/v1/internal/service-releases` — public (skip JWT) — apikey no — register — extras: `X-Service-Token`
- `POST /api/v1/internal/service-releases/digest` — public (skip JWT) — apikey no — attachDigest

### SettingsCatalogController

- **File:** `src/modules/settings-catalog/settings-catalog.controller.ts`
- **Prefix:** `admin/settings` → `api/v1/admin/settings`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:settings:manage`
- **JWT / other:** read:GlobalSetting

- `GET /api/v1/admin/settings/catalog` — jwt read:GlobalSetting — apikey yes — getCatalog
- `GET /api/v1/admin/settings/effective` — jwt read:GlobalSetting — apikey yes — getEffective — extras: `resolveScopedTenantId`

### SettingsRegistryWriteController

- **File:** `src/modules/settings-catalog/settings-registry-write.controller.ts`
- **Prefix:** `admin/settings` → `api/v1/admin/settings`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:settings:manage`
- **JWT / other:** read/manage:GlobalSetting
- **Notes:** PUT uses ExpectedVersion, not RequiresIfMatch.

- `GET /api/v1/admin/settings/registry/:key` — jwt read:GlobalSetting — apikey yes — getSetting
- `PUT /api/v1/admin/settings/registry/:key` — jwt manage:GlobalSetting — apikey yes — putSetting — extras: ExpectedVersion (not RequiresIfMatch); `globalOnly` 403 in service

### SpeechProxyController

- **File:** `src/modules/speech/speech-proxy.controller.ts`
- **Prefix:** `speech` → `api/v1/speech`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `tts:speech:write`
- **JWT / other:** @Authorize()
- **Notes:** Synthesize may be SSE or audio bytes.

- `POST /api/v1/speech/synthesize` — jwt (empty `@Authorize()`) — apikey yes — synthesize
- `GET /api/v1/speech/voices` — jwt (empty `@Authorize()`) — apikey yes — voices

### TenantFrontendConfigAdminController

- **File:** `src/modules/tenant-frontend-config/tenant-frontend-config-admin.controller.ts`
- **Prefix:** `admin/tenant-frontend-config` → `api/v1/admin/tenant-frontend-config`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `admin:tenant-frontend-config:manage`
- **JWT / other:** manage|update:Tenant

- `GET /api/v1/admin/tenant-frontend-config` — jwt manage\|update:Tenant — apikey yes — get
- `PUT /api/v1/admin/tenant-frontend-config` — jwt manage\|update:Tenant — upsert — extras: ExpectedVersion (not RequiresIfMatch)

### TextCompatController

- **File:** `src/modules/text-compat/text-compat.controller.ts`
- **Prefix:** `api/smr/api/v1 (prefix excluded)` → `api/smr/api/v1 (prefix excluded)`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `consultation:report:write`
- **JWT / other:** @Authorize()
- **Notes:** POST /api/smr/api/v1/{summary/sync,presummary}. SSE if body.stream===true.

- `POST /api/smr/api/v1/summary/sync` — jwt (empty `@Authorize()`) — apikey yes (`consultation:report:write`) — summarySync
- `POST /api/smr/api/v1/presummary` — jwt (empty `@Authorize()`) — apikey yes (`consultation:report:write`) — presummary

### UserPreferencesController

- **File:** `src/modules/user/controllers/user-preferences.controller.ts`
- **Prefix:** `user/me/preferences` → `api/v1/user/me/preferences`
- **api_count:** 2
- **Auth model:** JWT + API key
- **API key:** `user:preferences:write`
- **JWT / other:** @Authorize()
- **Notes:** Self CLS user.

- `GET /api/v1/user/me/preferences` — jwt auth — apikey yes — getPreferences
- `PATCH /api/v1/user/me/preferences` — jwt auth — apikey yes — updatePreferences

### UserSettingsController

- **File:** `src/modules/user/controllers/user-settings.controller.ts`
- **Prefix:** `user/me/settings` → `api/v1/user/me/settings`
- **api_count:** 2
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize()

- `GET /api/v1/user/me/settings` — jwt auth — apikey no — getMySettings
- `PATCH /api/v1/user/me/settings/:namespace/:key` — jwt auth — apikey no — updateSetting

### AdminImpersonationController

- **File:** `src/modules/auth/admin-impersonation.controller.ts`
- **Prefix:** `admin/users` → `api/v1/admin/users`
- **api_count:** 1
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** manage:all
- **Notes:** SUPER_ADMIN impersonation. Throttled.

- `POST /api/v1/admin/users/:id/impersonate` — jwt `manage:all` — apikey no ForbidApiKey — throttle 10/min — `impersonate`

### AgenticAdminController

- **File:** `src/modules/agentic-admin/agentic-admin.controller.ts`
- **Prefix:** `admin/agentic` → `api/v1/admin/agentic`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:agentic:manage`
- **JWT / other:** @Authorize() + manage:HarnessPolicy
- **Notes:** GET instructions.

- `GET /api/v1/admin/agentic/instructions` — jwt `@Authorize()` + `@CanManage(HarnessPolicy)` — apikey yes `admin:agentic:manage` — `getInstructions`

### ConsentInternalController

- **File:** `src/modules/consultation/consent-internal.controller.ts`
- **Prefix:** `internal/consent` → `api/v1/internal/consent`
- **api_count:** 1
- **Auth model:** Service token
- **API key:** `n/a — X-Service-Token (HarnessServiceTokenGuard)`
- **JWT / other:** skipped (@Public)
- **Notes:** POST assert.

- `POST /api/v1/internal/consent/assert` — public + `HarnessServiceTokenGuard` — apikey n/a — `assert`

### DepartmentAgentResyncController

- **File:** `src/modules/department-agent/department-agent-resync.controller.ts`
- **Prefix:** `admin/department-agents` → `api/v1/admin/department-agents`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:department-agent:manage`
- **JWT / other:** manage:Tenant
- **Notes:** SUPER_ADMIN resync.

- `POST /api/v1/admin/department-agents/resync` — jwt `CanManage(Tenant)` — apikey yes `admin:department-agent:manage` — `resync`

### EffectiveConfigController

- **File:** `src/modules/internal/effective-config.controller.ts`
- **Prefix:** `internal/effective-config` → `api/v1/internal/effective-config`
- **api_count:** 1
- **Auth model:** Service token
- **API key:** `n/a — X-Service-Token (InternalServiceTokenGuard)`
- **JWT / other:** skipped (@Public)

- `GET /api/v1/internal/effective-config` — public + `InternalServiceTokenGuard` — apikey n/a — `getEffectiveConfig`

### ForgotPasswordController

- **File:** `src/modules/user/controllers/forgot-password.controller.ts`
- **Prefix:** `auth` → `api/v1/auth`
- **api_count:** 1
- **Auth model:** Public
- **API key:** `n/a`
- **JWT / other:** none
- **Notes:** Throttled 5/min.

- `POST /api/v1/auth/forgot-password` — public — n/a — throttle 5/min — `request`

### MyEntitlementsController

- **File:** `src/modules/entitlements/my-entitlements.controller.ts`
- **Prefix:** `entitlements` → `api/v1/entitlements`
- **api_count:** 1
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** read:Tenant

- `GET /api/v1/entitlements/me` — jwt `read:Tenant` — apikey **forbidden** — CLS tenant

### MyTenantContextSchemaController

- **File:** `src/modules/consultation-context-schema/consultation-context-schema.controller.ts`
- **Prefix:** `tenant/me/context-schema` → `api/v1/tenant/me/context-schema`
- **api_count:** 1
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize()
- **Notes:** Same file as ConsultationContextSchemaAdminController.

- `GET /api/v1/tenant/me/context-schema` — jwt `@Authorize()` — apikey no ForbidApiKey — `getEffective`

### PasswordResetController

- **File:** `src/modules/user/controllers/password-reset.controller.ts`
- **Prefix:** `users/password-reset` → `api/v1/users/password-reset`
- **api_count:** 1
- **Auth model:** Public
- **API key:** `n/a`
- **JWT / other:** none
- **Notes:** POST complete. Token in body.

- `POST /api/v1/users/password-reset/complete` — **public** — apikey no — single-use token in body; 400 on invalid/expired (no user enum)

### PrismaStudioStatusController

- **File:** `src/modules/pstudio/pstudio-status.controller.ts`
- **Prefix:** `admin/pstudio/status` → `api/v1/admin/pstudio/status`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:pstudio:manage`
- **JWT / other:** manage:PrismaStudio

- `GET /api/v1/admin/pstudio/status` — jwt `manage:PrismaStudio` — apikey `admin:pstudio:manage` — `{ enabled }` from `ENABLE_PRISMA_STUDIO`

### TenantPipelineResyncController

- **File:** `src/modules/tenant/tenant-pipeline-resync.controller.ts`
- **Prefix:** `admin/tenants` → `api/v1/admin/tenants`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:tenant:write`
- **JWT / other:** manage:Tenant
- **Notes:** SUPER_ADMIN.

- `POST /api/v1/admin/tenants/:id/pipelines/resync` — jwt manage:Tenant — apikey yes (`admin:tenant:write`) — resync

### TenantProvisionController

- **File:** `src/modules/tenant/tenant-provision.controller.ts`
- **Prefix:** `admin/tenants` → `api/v1/admin/tenants`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:tenant:write`
- **JWT / other:** manage:Tenant
- **Notes:** SUPER_ADMIN.

- `POST /api/v1/admin/tenants/provision` — jwt manage:Tenant — apikey yes (`admin:tenant:write`) — provision

### UserDepartmentsMeController

- **File:** `src/modules/user/controllers/user-departments-me.controller.ts`
- **Prefix:** `user/me/departments` → `api/v1/user/me/departments`
- **api_count:** 1
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize()

- `GET /api/v1/user/me/departments` — jwt auth — apikey no (ForbidApiKey) — myDepartments

### UserRolesController

- **File:** `src/modules/user/controllers/user-roles.controller.ts`
- **Prefix:** `users` → `api/v1/users`
- **api_count:** 1
- **Auth model:** JWT only
- **API key:** `forbidden`
- **JWT / other:** @Authorize(); :id must equal caller

- `GET /api/v1/users/:id/roles` — jwt auth — apikey no — listMyRoleAssignments — extras: `:id` must equal caller (403 else)

### WorkflowNodeController

- **File:** `src/modules/workflow-node/workflow-node.controller.ts`
- **Prefix:** `admin/workflow-nodes` → `api/v1/admin/workflow-nodes`
- **api_count:** 1
- **Auth model:** JWT + API key
- **API key:** `admin:workflow-node:read`
- **JWT / other:** read:WorkflowDefinition
- **Notes:** Read-only registry.

- `GET /api/v1/admin/workflow-nodes` — jwt read:WorkflowDefinition — apikey yes (`admin:workflow-node:read`) — fetchAll

---

## 5. WebSocket gateways

No GraphQL. No `@SubscribeMessage`. All three gateways use native `WsAdapter` + raw `client.on('message')`. Nest `APP_GUARD` / `UnifiedAuthGuard` **do not run**. Paths are **not** under `api/v1`. `handleDisconnect` is teardown and is not counted as an API.

### SttWsGateway

- **File:** `src/modules/streaming/stt-ws.gateway.ts`
- **Path:** `/ws/stt/stream (no api/v1)`
- **api_count:** 6 (handshake + inbound protocol types)
- **Auth model:** Stream ticket
- **API key:** no — ?ticket= scoped stt_session:<id>
- **JWT / other:** n/a — Nest APP_GUARD does not run
- **Notes:** Raw ws. Origin check + Redis tenant binding. Binary + JSON audio/stop/resume/close.

### TtsWsGateway

- **File:** `src/modules/speech/tts-ws.gateway.ts`
- **Path:** `/ws/tts/stream (no api/v1)`
- **api_count:** 5 (handshake + inbound protocol types)
- **Auth model:** Stream ticket
- **API key:** no — ?ticket= scoped tts_session:<id>
- **JWT / other:** n/a — APP_GUARD does not run
- **Notes:** No Redis tenant-binding cross-check. Quota close 4429.

### SttCompatGateway

- **File:** `src/modules/stt-compat/stt-compat.gateway.ts`
- **Path:** `/stt (no api/v1)`
- **api_count:** 4 (handshake + inbound protocol types)
- **Auth model:** API key (WS)
- **API key:** WS headers `apikey`/`api-key`/`x-api-key`/`x-internal-service-key`, or query `apiKey`/`api-key`/`key`
- **JWT / other:** n/a
- **Notes:** Legacy v1. Session tenant must match key tenant.

#### SttWsGateway inbound

**Connect:** `/ws/stt/stream?sessionId=&ticket=`

1. CSWSH: if `Origin` is present and enforcement is on → `IOriginRegistry.has()` (fail-closed). Missing Origin is allowed (non-browser).
2. Consume single-use `ticket` via `StreamTicketService`.
3. Scope must be `stt_session:<sessionId>`.
4. Ticket `tenantId` must match Redis session binding (`StreamSessionTenantBindingService.lookup`). Fail-closed, generic close `4401 Authentication failed`.

| Handler | Client-facing | Protocol |
|---|---|---|
| `handleConnection` | yes | handshake |
| `handleDisconnect` | no (15s resume grace) | teardown |
| inbound binary | yes | PCM audio → Redis bridge |
| `{type:'audio', seq, data}` | yes | JSON base64 audio |
| `{type:'stop'}` | yes | finalize upstream |
| `{type:'resume', sessionId, lastSeq}` | yes | replay buffer |
| `{type:'close'}` | yes | finalize immediately, close 1000 |

Server→client: `ready`, `resumed` / `resume_failed`, `transcript` (+`seq`), `status`, `gap`, `error`.

#### TtsWsGateway inbound

**Connect:** `/ws/tts/stream?sessionId=&ticket=`

Connect sequence, in order:

1. **Origin / CSWSH check** (TASK-755 G-1) — runs FIRST, before `sessionId`/`ticket` parsing, so a hostile origin never burns a ticket. Registry-backed (`IOriginRegistry`), fail-CLOSED on an absent / empty / throwing registry under the greppable `origin_registry_unavailable` reason; an ordinary refusal logs `origin_registry_miss`. The enforcement switch is read from `cors.config.ts#isOriginEnforcementEnabled` — never re-resolved locally, so the WS gate can never disagree with the HTTP gate. A **missing/empty** `Origin` header is ALLOWED (non-browser caller). Rejection closes with the gateway's existing generic `4401`, byte-identical to every other handshake rejection.
2. **Ticket consumption** — scope `tts_session:<sessionId>`. **No** Redis tenant-binding cross-check, and this is not a gap: there is no server-side TTS session resource to bind. Each connect opens its own socket-keyed bridge, so two connections sharing a `sessionId` cannot see or displace each other. If TTS ever gains a session-create route, this note expires and the STT binding must be mirrored here (TASK-755 §Design decision, Option B).
3. **Quota pre-flight** — `assertMeterQuota(monthlyTtsCharacters, 0)` → close `4429` if over.

Upstream hop injects `X-Service-Token`.

| Handler | Client-facing | Protocol |
|---|---|---|
| `handleConnection` | yes | handshake |
| `handleDisconnect` | no | teardown bridge |
| inbound `{type:'init'}` | yes | enriched with tenant TTS config once |
| inbound `{type:'text'\|'flush'\|'end'}` | yes | relayed verbatim (3 types) |

Server→client: binary PCM + JSON control. Upstream `{type:'usage'}` is consumed for the ledger and **not** forwarded.

#### SttCompatGateway inbound

**Connect:** `/stt?sessionId=` plus API key in WS headers (`apikey` / `api-key` / `x-api-key` / `x-internal-service-key`) or query (`apiKey` / `api-key` / `key` — query is always allowed on this WS path).

Auth: authenticate raw key → lookup session tenant → reject unless `apiKey.tenantId === boundTenant` and the session exists. Generic `4401`.

| Handler | Client-facing | Protocol |
|---|---|---|
| `handleConnection` | yes | handshake; emits `{type:'connected'}` |
| `handleDisconnect` | no | `removeSession(..., interrupted:true)` |
| text `{type:'ping'}` | yes | `{type:'pong'}` |
| text `{type:'stop'}` | yes | `finalize` control |
| binary audio frame | yes | type-byte `1` + metadata length + PCM |

Server→client envelope: `{event:'message'\|'error', data, sessionId}` with `transcription` / `status` / `error`.

---

## 6. SSE inventory

Nine `@Sse()` handlers (always paired with `@Get`, counted as one HTTP handler each) plus hand-rolled `text/event-stream` routes that are **not** `@Sse()` (so `TenantOwnedResourceSseGuard` metadata does not apply). Global `TenantOwnedResourceSseGuard` (after `UnifiedAuthGuard`) pre-asserts `@TenantOwnedResource` on `@Sse()` routes and re-checks while the stream is open.

### `@Sse()` (9)

| Controller | Method | Path | StreamScope | Extra |
|---|---|---|---|---|
| ConsultationController | GET | `/api/v1/consultations/:id/live-summary/stream` | `consultation_live_summary:<id>` | Redis `consultation:live-summary:{id}` |
| ConsultationController | GET | `/api/v1/consultations/:id/harness-progress/stream` | `consultation_harness_progress:<id>` | Redis harness-progress |
| ConsultationController | GET | `/api/v1/consultations/:id/harness-assurance/stream` | `consultation_harness_assurance:<id>` | Redis harness-assurance |
| ConsultationController | GET | `/api/v1/consultations/:id/trajectory/stream` | `consultation_trajectory:<id>` | Redis + heartbeat |
| ConsultationController | GET | `/api/v1/consultations/:id/loop/stream` | `consultation_loop:<id>` | Redis + heartbeat |
| ConsultationJobController | GET | `/api/v1/consultations/jobs/:jobId/stream` | `consultation_job:<jobId>` | job status SSE |
| TranscriptionJobController | GET | `/api/v1/audio/transcription-jobs/:id/stream` | `transcription_job:<id>` | job events |
| DnaWritingStyleController | GET | `/api/v1/dna-writing-styles/jobs/:jobId/stream` | **none** (ticket will 401) | JWT only; `@ForbidApiKey()` |
| DnaWritingStyleAdminController | GET | `/api/v1/admin/dna-writing-styles/jobs/:jobId/stream` | `dna_job:<jobId>` | admin |

### Hand-rolled streams (not `@Sse()`)

| Controller | Method | Path | Auth | Implementation |
|---|---|---|---|---|
| WorkflowsController | GET | `/api/v1/workflows/:slug/runs/:runId/stream` | JWT/API-key `workflow:run:read` or ticket `workflow_run:<runId>` | poll `getRunStatus` every 2s |
| WorkflowSandboxRunController | GET | `/api/v1/admin/workflow-definitions/:definitionId/sandbox-runs/:runId/stream` | JWT admin scope or ticket `workflow_run:<runId>` | same poll pattern |
| TextProxyController | GET | `/api/v1/text/tasks/:taskId/stream` | JWT/ticket `text_task:<taskId>` + class `consultation:report:write` | byte-pipe to text service SSE |
| TextCompatController | POST | `/api/smr/api/v1/summary/sync` | JWT/API-key `consultation:report:write` | SSE iff `body.stream===true`; no ticket |
| TextCompatController | POST | `/api/smr/api/v1/presummary` | JWT/API-key `consultation:report:write` | SSE iff `body.stream===true`; no ticket |
| SpeechProxyController | POST | `/api/v1/speech/synthesize` | JWT/API-key `tts:speech:write` | may be SSE or audio bytes |

`POST /api/v1/auth/stream-ticket` (AuthController, JWT, `@ForbidApiKey()`) mints the one-shot tickets used by `@StreamScope` SSE/WS routes. TTL ~30s, Redis GET+DEL.

---

## 7. Completeness

| Check | Result |
|---|---|
| HTTP `@Controller` classes | **104**, all present in module `controllers: [...]` arrays |
| Live controller files | **102** under `apps/api/src` |
| Dual-class files (do not double-count) | `src/modules/ai-provider-connection/ai-provider-connection.controller.ts` → `ProviderConnectionController` (`admin/providers`) + `AiProviderConnectionController` (`admin/ai-providers`); `src/modules/consultation-context-schema/consultation-context-schema.controller.ts` → `ConsultationContextSchemaAdminController` + `MyTenantContextSchemaController` |
| Unused abstract | `BaseProxyController` in `src/shared/base-proxy.controller.ts` — no `@Controller()`, unused by live controllers, not registered |
| HTTP/SSE handler sum | **605** (this document’s `api_count` column and per-controller bullets) |
| `SttInternalController` | **10** handlers (not 9): transcripts, streaming/usage, jobs start/progress/complete/fail/status, audio-records, media, provider-overrides |
| `ConsentGrantController` | JWT-only (`@ForbidApiKey()`); **not** API-key reachable |
| WebSocket gateways | **3**, all registered as module `providers` |
| GraphQL | none |
| Duplicate class names | none. Shared prefixes are intentional splits (different methods) |

### Global prefix exclusions (`main.ts`)

| Path | Method | Controller |
|---|---|---|
| `/metrics` | GET | vendored `PrometheusController` |
| `/api/smr/api/v1/summary/sync` | POST | `TextCompatController` |
| `/api/smr/api/v1/presummary` | POST | `TextCompatController` |
| `/api/stt/start_session` | POST | `SttCompatController` |
| `/api/stt/stop_session` | POST | `SttCompatController` |
| `/api/stt/switch` | POST | `SttCompatController` |

WebSocket paths (never under `api/v1`): `/ws/stt/stream`, `/ws/tts/stream`, `/stt`.

### Vendored Prometheus

- **Class:** `PrometheusController` (`@willsoto/nestjs-prometheus`)
- **Path:** `GET /metrics` (prefix-excluded)
- **Auth:** `@Public()` via `SKIP_AUTH_KEY` patch in `src/bootstrap/third-party-public-routes.ts` (`PrometheusController.prototype.index`)
- **API key:** n/a
- **Notes:** scrape surface registered by `ObservabilityModule`. Not an `apps/api` controller file.

Swagger `/api/v1/docs` is Express setup in non-production only — not a Nest controller, not in the route-permission audit.

### Shared HTTP prefixes (intentional splits)

| Prefix | Classes |
|---|---|
| `admin/ai-models` | `AiModelDiscoveryController`, `AiModelAdminController` |
| `admin/department-agents` | `DepartmentAgentController`, `DepartmentAgentResyncController` |
| `admin/settings` | `GlobalSettingController`, `SettingsCatalogController`, `SettingsRegistryWriteController` |
| `admin/tenants` | `TenantController`, `TenantProvisionController`, `TenantPipelineResyncController` |
| `admin/users` | `UserController`, `UserDepartmentsController`, `AdminImpersonationController` |
| `auth` | `AuthController`, `RegisterController`, `ForgotPasswordController` |

### Recount (this file)

- HTTP controller headings (`### *Controller` in §4): **104**
- HTTP endpoint bullets in §4: **605**
- WebSocket gateway headings (`### *Gateway` in §5): **3**
- Vendored Prometheus: completeness §7 only

