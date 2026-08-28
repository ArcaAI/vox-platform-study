/**
 * A CASL permission a scope implies — structurally identical to
 * `RequiredPermission` (`../../authorization/authorization.guard`), restated
 * here so the registry stays importable from the gateway's decorator layer
 * without pulling in guard runtime code.
 */
export interface ImpliedPermission {
  action: string;
  subject: string;
}

export interface ScopeDefinition {
  description: string;
  category: string;
  /**
   * TASK-756 — the privilege CEILING on minting: the CASL ability a holder of
   * this scope may exercise. `ApiKeyService.assertScopeCeiling` refuses to mint
   * (or widen) a key carrying a scope whose implications the CALLER does not
   * itself hold, so a credential can never out-rank the human who created it.
   *
   * How the values were derived — one rule, applied per scope:
   *   1. Take the CASL permission the scope's own controller declares
   *      (`@CanXxx`/`@Authorize`); the controller→scope half of this mapping is
   *      `apps/api/src/bootstrap/admin-scope-audit.ts`.
   *   2. Where the class-level decorator is only `@Authorize()` (authenticated,
   *      no subject) — or exists solely to satisfy the deny-by-default boot
   *      audit, as `AdminTranscriptionJobController` documents — use the
   *      method-level declarations instead.
   *   3. Where a controller declares an OR set (`@CanAny`), take the
   *      least-privileged branch: holding it already makes the surface reachable.
   *   4. Where one scope gates several controllers, union them (checked with
   *      AND) — the scope unlocks all of them.
   *
   * Surfaces gated only by authentication (the consultation/STT/TTS runtime
   * plane) carry the corresponding `Consultation` ability: that is the resource
   * the plane operates on, and it is what every principal permitted to use it
   * already holds. This is deliberately conservative, never fail-open — an
   * empty `implies` would let a scope pass the ceiling unchecked, which is why
   * `apikey-scopes.registry.test.ts` requires every entry to declare one.
   *
   * Wildcards are the exception: they carry `[]` and are resolved by EXPANSION
   * in `resolveImpliedPermissions`, never by a literal of their own.
   */
  implies: ImpliedPermission[];

  /**
   * TASK-757 (policy A2) — this scope may no longer be GRANTED, but is still a
   * KNOWN string.
   *
   * `/api/v1/admin/*` is a JWT-only plane: all 65 admin controllers carry
   * `@ForbidApiKey()`, which `UnifiedAuthGuard` checks BEFORE the scope check,
   * so every `admin:*` scope — including the `admin:*` wildcard — is inert at
   * request time whatever a key holds. The `webhook:*` family goes with them:
   * its only consumer is `WebhookController` at `admin/webhooks`.
   *
   * Reserved, NOT deleted, for two reasons:
   *   1. `isValidScope` is what makes a STORED scope array readable. Deleting
   *      the strings would make every pre-existing key carrying one fail
   *      validation on an unrelated `PATCH`.
   *   2. They are the vocabulary TASK-762's service-account plane reuses.
   *
   * What `reserved` changes: the scope is refused at GRANT time
   * (`NoReservedScopesConstraint` on the create DTO; the widening-delta check
   * in `ApiKeyService.update()`) and dropped from the advertised catalog
   * (`getAvailableScopes`, `getScopesByCategory`). What it does NOT change:
   * `isValidScope` and `resolveImpliedPermissions`, both of which must keep
   * answering for already-stored scopes.
   *
   * `'*'` is deliberately NOT reserved — it is the platform SERVICE_ACCOUNT
   * wildcard for `/internal/*` and stays legitimate there; `@ForbidApiKey()`
   * alone makes it inert on the admin plane, which is exactly the property
   * that made a "reserved scope string" trick unnecessary as a GUARD (see
   * `API_KEY_FORBIDDEN`'s doc comment in `unified-auth.guard.ts`).
   */
  reserved?: true;
}

export const API_KEY_SCOPE_REGISTRY: Record<string, ScopeDefinition> = {
  // STT Service
  'stt:transcription:read': { description: 'Read transcription results', category: 'STT', implies: [{ action: 'read', subject: 'Consultation' }] },
  'stt:transcription:write': {
    description: 'Create and stream transcriptions',
    category: 'STT',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'stt:stream:write': {
    description: 'Stream audio for real-time transcription',
    category: 'STT',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'stt:model:read': { description: 'View available STT models', category: 'STT', implies: [{ action: 'read', subject: 'Consultation' }] },

  // TTS Service (TASK-742). The `/speech/*` proxy was one of the surfaces the
  // gateway conformance review named as reachable with NO authorization check
  // at all, because the API-key path permitted any route declaring no scopes.
  // Follows the same `<area>:<resource>:<action>` grammar as the `stt:*` family
  // above rather than borrowing an `stt:` scope: a key issued to transcribe
  // audio has no business synthesising speech, and reusing `stt:*` here would
  // have silently granted exactly that.
  'tts:speech:write': { description: 'Synthesize speech from text', category: 'TTS', implies: [{ action: 'create', subject: 'Consultation' }] },
  'tts:voice:read': { description: 'List available TTS voices', category: 'TTS', implies: [{ action: 'read', subject: 'Consultation' }] },

  // Consultation
  'consultation:session:read': {
    description: 'Read consultation sessions',
    category: 'Consultation',
    implies: [{ action: 'read', subject: 'Consultation' }],
  },
  'consultation:session:write': {
    description: 'Create and manage consultation sessions',
    category: 'Consultation',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  'consultation:report:read': {
    description: 'Read consultation reports/summaries',
    category: 'Consultation',
    implies: [{ action: 'read', subject: 'Consultation' }],
  },
  'consultation:report:write': {
    description: 'Generate consultation reports',
    category: 'Consultation',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },

  // User (Self)
  'user:profile:read': { description: 'Read own user profile', category: 'User', implies: [{ action: 'read', subject: 'UserProfile' }] },
  'user:preferences:read': { description: 'Read own preferences', category: 'User', implies: [{ action: 'read', subject: 'UserSettings' }] },
  'user:preferences:write': { description: 'Update own preferences', category: 'User', implies: [{ action: 'update', subject: 'UserSettings' }] },
  // TASK-758 — the raw key/value sibling of `user:preferences:*`
  // (`/user/me/settings`, which the typed preferences surface is an
  // aggregation over). Split read/write rather than following
  // `UserPreferencesController`'s single write scope, so a read-only
  // integration is expressible: the controller declares the read at class
  // level and the write on the PATCH handler alone.
  'user:settings:read': { description: 'Read own raw settings', category: 'User', implies: [{ action: 'read', subject: 'UserSettings' }] },
  'user:settings:write': { description: 'Update own raw settings', category: 'User', implies: [{ action: 'update', subject: 'UserSettings' }] },

  // Business plane (TASK-758 — policy A1: a non-`admin` route is JWT + API
  // key, so an integrator holding a scoped tenant key can drive the platform's
  // business capabilities without a human session). These 9 scopes replace the
  // conservative `@ForbidApiKey()` default TASK-742 applied to 13 controllers
  // that had DECLARED NOTHING — the classification those `API-KEY-NOTE` blocks
  // explicitly deferred to an owner ruling, not a reversal of one.
  //
  // Two surfaces are gated by scopes that already existed and needed no new
  // vocabulary: the ASR pipeline catalog (`AudioPipelinePublicController`)
  // reuses `stt:model:read`, and the three `me`-shaped reads
  // (`PermissionCheckController`, `UserDepartmentsMeController`,
  // `UserRolesController`) reuse `user:profile:read`, which was registered but
  // declared by nothing until now.
  //
  // `implies` follows this file's existing derivation rule: the CASL pair the
  // scope's own controller declares. Where the controller is auth-only
  // (`@Authorize()` with no subject) the resource the plane OPERATES ON is
  // used — `Consultation` for the inference proxy, matching the STT/TTS
  // runtime-plane precedent above.
  'ai:inference:write': {
    description: 'Run guardrail / NLP inference over caller-supplied text',
    category: 'AI',
    implies: [{ action: 'create', subject: 'Consultation' }],
  },
  // READ-shaped on purpose. Three of this controller's five routes are WRITES
  // declared with `read:PromptTemplate`, with caller-ownership enforced inside
  // `PromptManagementService` (the `AUTH-NOTE` at prompt-template.controller.ts).
  // A `prompt:template:write` scope would suggest the key may mutate any
  // template, which is exactly what the service refuses; the scope must not
  // over-promise what the ability re-check will then deny.
  'prompt:template:read': {
    description: "Read the prompt templates the key's bound clinician may use (personal writes stay owner-gated in the service)",
    category: 'Prompt',
    implies: [{ action: 'read', subject: 'PromptTemplate' }],
  },
  'platform:changelog:read': {
    description: 'Read and acknowledge the release notes visible to the bound user',
    category: 'Platform',
    implies: [{ action: 'read', subject: 'ChangelogEntry' }],
  },

  // Tenant self-service. These resolve to the KEY'S TENANT (the CLS `tenantId`
  // `UnifiedAuthGuard.handleApiKeyAuth` sets from `apiKeyEntity.tenantId`) —
  // NOT to the bound user, which is the `user:*` family's semantics. The two
  // are documented per-route in OpenAPI because an integrator cannot tell them
  // apart from the path alone.
  'tenant:account:read': {
    description: "Read the key tenant's own billing, usage and entitlements",
    category: 'Tenant',
    implies: [{ action: 'read', subject: 'Tenant' }],
  },
  'tenant:profile:read': {
    description: "Read the key tenant's own profile and configuration",
    category: 'Tenant',
    implies: [{ action: 'read', subject: 'Tenant' }],
  },
  'tenant:profile:write': {
    description: "Update the key tenant's own configuration",
    category: 'Tenant',
    implies: [{ action: 'update', subject: 'Tenant' }],
  },
  'tenant:context-schema:read': {
    description: "Discover the key tenant's pinned consultation context schema",
    category: 'Tenant',
    implies: [{ action: 'read', subject: 'ConsultationContextSchema' }],
  },
  // TASK-810 — the sibling discovery scope: context-schema answers "what may I
  // submit", this answers "what document will come back". A client that renders
  // a generated note needs its section list before the first token arrives, and
  // hardcoding them client-side is the mistake this ticket removed server-side.
  'tenant:document-template:read': {
    description: "Discover the key tenant's pinned clinical-document template",
    category: 'Tenant',
    implies: [{ action: 'read', subject: 'DocumentTemplate' }],
  },

  // Media
  'media:file:read': { description: 'Read/download media files', category: 'Media', implies: [{ action: 'read', subject: 'Storage' }] },
  'media:file:write': { description: 'Upload media files', category: 'Media', implies: [{ action: 'create', subject: 'Storage' }] },

  // Admin
  'admin:user:read': {
    description: 'Read user information',
    category: 'Admin',
    // TASK-773 / O-4 — `read:Admin<X>Directory` is an ADMIN-PLANE-ONLY subject,
    // minted so a read-only machine grant can clear the admin routes' CASL gate
    // WITHOUT widening a subject humans already hold. Route decorators are
    // shared by every principal class, so accepting `read:User` on those
    // routes instead would have handed them to DEPARTMENT_HEAD and SENIOR_NURSE, which hold `read:User`
    // tenant-scoped via the `consultation-department-read` policy.
    // No seeded policy grants this subject, so no human role gains anything;
    // a service account's abilities are BUILT from its scopes, so it does.
    // Precedent: `TenantTelemetry`, minted the same way to widen the monitoring
    // and service-release gates without touching a broad subject.
    implies: [
      { action: 'read', subject: 'User' },
      { action: 'read', subject: 'AdminUserDirectory' },
    ],
    reserved: true,
  },
  'admin:user:write': { description: 'Manage users', category: 'Admin', implies: [{ action: 'manage', subject: 'User' }], reserved: true },
  'admin:apikey:read': { description: 'Read API keys', category: 'Admin', implies: [{ action: 'read', subject: 'ApiKey' }], reserved: true },
  'admin:apikey:write': { description: 'Manage API keys', category: 'Admin', implies: [{ action: 'manage', subject: 'ApiKey' }], reserved: true },
  'admin:tenant:read': {
    description: 'Read tenant configuration',
    category: 'Admin',
    // TASK-773 / O-4 — `read:Admin<X>Directory` is an ADMIN-PLANE-ONLY subject,
    // minted so a read-only machine grant can clear the admin routes' CASL gate
    // WITHOUT widening a subject humans already hold. Route decorators are
    // shared by every principal class, so accepting `read:Tenant` on those
    // routes instead would have handed them to EVERY authenticated user, which holds `read:Tenant` via the
    // `user-profile-own` policy.
    // No seeded policy grants this subject, so no human role gains anything;
    // a service account's abilities are BUILT from its scopes, so it does.
    // Precedent: `TenantTelemetry`, minted the same way to widen the monitoring
    // and service-release gates without touching a broad subject.
    implies: [
      { action: 'read', subject: 'Tenant' },
      { action: 'read', subject: 'AdminTenantDirectory' },
    ],
    reserved: true,
  },
  'admin:tenant:write': {
    description: 'Manage tenant settings',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Tenant' }],
    reserved: true,
  },
  'admin:audit:read': { description: 'Read audit logs', category: 'Admin', implies: [{ action: 'read', subject: 'AuditLog' }], reserved: true },
  'admin:role:read': { description: 'Read roles and policies', category: 'Admin', implies: [{ action: 'read', subject: 'Role' }], reserved: true },
  'admin:role:write': {
    description: 'Manage roles and policies',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Role' }],
    reserved: true,
  },

  // Webhooks
  'webhook:event:read': {
    description: 'Read webhook events',
    category: 'Webhook',
    // TASK-773 / O-2 — `read:WebhookRunHistory` belongs here. The scope is named
    // "read webhook EVENTS" and the delivery log IS the event record
    // (`GET admin/webhooks/:id/deliveries`, `@Authorize(['read','WebhookRunHistory'])`),
    // so a holder that could read the subscription but not its deliveries was
    // under-specified rather than deliberately narrowed. Completing it here —
    // instead of widening the route to accept `read:Webhook` — is what keeps the
    // fix off the human plane: route decorators are shared by every principal
    // class, whereas `implies` reaches only credentials whose abilities are
    // BUILT from scopes. Human abilities come from DB policies
    // (`tenant-full-access` is the only one granting `read:WebhookRunHistory`),
    // so no role gains anything; and `admin/webhooks` is `@ForbidApiKey()`, so
    // no API key can reach the route regardless.
    implies: [
      { action: 'read', subject: 'Webhook' },
      { action: 'read', subject: 'WebhookRunHistory' },
    ],
    reserved: true,
  },
  'webhook:event:write': {
    description: 'Manage webhook subscriptions',
    category: 'Webhook',
    implies: [{ action: 'manage', subject: 'Webhook' }],
    reserved: true,
  },

  // Internal (platform-only). Reserved for service-to-service credentials —
  // never issued to a tenant SDK/WEBHOOK/INTEGRATION key. Gates
  // `SttInternalController` (`/internal/stt/*`), which the STT worker calls
  // with the platform SERVICE_ACCOUNT credential (scopes: `['*']`, which
  // satisfies this via `hasScope`'s wildcard grant — no seed/provisioning
  // change needed). See `apps/api/src/modules/internal/stt-internal.controller.ts`.
  //
  // Why a reserved scope rather than pulling `/internal/*` fully off the
  // API-key surface: the STT worker authenticates with `X-Internal-Service-Key`
  // carrying `api_gateway_key`, which BUG-013 requires to be the RAW value of a
  // registered ACTIVE SERVICE_ACCOUNT ApiKey row (`apps/stt/src/stt/worker.py`,
  // `core/effective_config.py`). It presents an API KEY, not a service token, so
  // a `@Public()` + service-token-guard rework would break the worker unless
  // `apps/stt` changed in lockstep. The owner's "`/admin/*` and `/internal/*`
  // are different purposes" rule is honoured by the SEPARATE `internal:` root —
  // prefix matching cannot cross it — not by a different auth mechanism.
  'internal:stt:worker': {
    description: 'STT worker service-to-service callbacks (never issued to a tenant key)',
    category: 'Internal',
    implies: [{ action: 'manage', subject: 'all' }],
  },

  // Admin (platform/tenant-admin surface, `/admin/*`). One scope per admin
  // controller area — TASK-708 Task 4 gap closure. Coarse-grained by design
  // (one scope per controller, not per read/write method) so the sweep is
  // mechanically verifiable across every `/admin/*` controller in one pass
  // without risking a missed-method gap; `admin:tenant:*`, `admin:user:*`,
  // `admin:apikey:*`, `admin:audit:read`, `admin:role:*` above predate this
  // pass and are reused where a controller's whole surface maps cleanly onto
  // one of them. See the ticket README's Task 3/4 tables for the full
  // controller → scope mapping and the sensitivity notes per area.
  'admin:rate-limit:manage': {
    description: 'Manage platform rate-limit configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:usage:manage': {
    description: 'Read/reconcile usage analytics',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'UsageAnalytics' }],
    reserved: true,
  },
  'admin:agent-promotion:manage': {
    description: 'Manage cross-tenant workflow promotions',
    category: 'Admin',
    // TASK-815 repointed this implication with the promotable itself: promotion
    // moved from a `DepartmentAgentVersion` to a `WorkflowDefinition` version,
    // and `AgentPromotionService.assertManagesBothTenants` now asks for
    // `manage:WorkflowDefinition` in both tenants. A scope that still implied
    // the deleted subject would grant nothing at all.
    implies: [{ action: 'manage', subject: 'WorkflowDefinition' }],
    reserved: true,
  },
  'admin:agent-trajectory:read': {
    description: 'Read agent trajectory steps',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'AgentTrajectory' }],
    reserved: true,
  },
  'admin:agentic:manage': {
    description: 'Manage agentic policy administration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'HarnessPolicy' }],
    reserved: true,
  },
  'admin:ai-model:manage': {
    description: 'Manage AI model registrations and discovery',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:ai-provider:manage': {
    description: 'Manage AI/model provider connections (HIGH sensitivity — provider credentials)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'GlobalSetting' }],
    reserved: true,
  },
  'admin:ai-runtime-profile:manage': {
    description: 'Manage AI runtime profiles',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:ai-service:manage': {
    description: 'Manage AI service configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:ai-task-default:manage': {
    description: 'Manage AI task defaults (some sub-routes are additionally SUPER_ADMIN-only via SUPER_ADMIN_ONLY_TASK_PREFIXES)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'AiTaskDefault' }],
    reserved: true,
  },
  'admin:billing:manage': {
    description: 'Manage billing invoices and rate cards',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'BillingInvoice' },
      { action: 'manage', subject: 'AiPriceBook' },
    ],
    reserved: true,
  },
  'admin:changelog:manage': {
    description: 'Manage changelog entries',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ChangelogEntry' }],
    reserved: true,
  },
  'admin:consultation-context-schema:manage': {
    description: 'Manage consultation context schemas',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ConsultationContextSchema' }],
    reserved: true,
  },
  // TASK-810 — the clinical-document SHAPE catalog. RESERVED like every other
  // `admin:*` scope (an API key can never reach an admin route — policy A2),
  // but the vocabulary still has to exist here: `SERVICE_ACCOUNT_SCOPE_REGISTRY`
  // DERIVES `svc:admin:document-template:manage` from this row rather than
  // re-typing it, which is what keeps boot-audit assertion D ("every admin area
  // is covered by exactly one `svc:*` scope") true by construction.
  'admin:document-template:manage': {
    description: 'Manage clinical-document templates',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'DocumentTemplate' }],
    reserved: true,
  },
  'admin:consultation-admin:manage': {
    description: 'Manage consultations from the admin surface',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Consultation' }],
    reserved: true,
  },
  'admin:department-agent:manage': {
    description: 'Manage department agents and their resync',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'DepartmentAgent' },
      { action: 'manage', subject: 'Tenant' },
    ],
    reserved: true,
  },
  'admin:department:manage': {
    description: 'Manage departments',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Department' }],
    reserved: true,
  },
  'admin:dna-writing-style:manage': {
    description: 'Manage DNA writing style reports',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'DnaWritingStyleReport' }],
    reserved: true,
  },
  'admin:entitlement:manage': {
    description: 'Manage tenant entitlements',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:settings:manage': {
    description: 'Read/manage platform global settings (HIGH sensitivity — platform-wide knobs)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'GlobalSetting' }],
    reserved: true,
  },
  'admin:harness:manage': {
    description: 'Manage the Clinical Documentation Harness admin surface',
    category: 'Admin',
    implies: [
      { action: 'manage', subject: 'HarnessPolicy' },
      { action: 'manage', subject: 'HarnessEval' },
      { action: 'manage', subject: 'HarnessWorkflow' },
      { action: 'read', subject: 'HarnessAudit' },
    ],
    reserved: true,
  },
  'admin:knowledge:manage': {
    description: 'Manage the institutional-RAG knowledge corpus (inspect, archive, delete — governance, not ingestion)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'KnowledgeDocument' }],
    reserved: true,
  },
  'admin:mcp-server:manage': {
    description: 'Manage MCP server registrations',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'McpServer' }],
    reserved: true,
  },
  'admin:nlp-task-instructions:manage': {
    description: 'Manage tenant NLP task instructions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantNlpTaskInstructions' }],
    reserved: true,
  },
  'admin:notification:manage': {
    description: 'Manage platform notifications',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Notification' }],
    reserved: true,
  },
  'admin:pipeline-policy:manage': {
    description: 'Manage harness pipeline policy (carries the globalOnly descriptor lock on some fields)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PipelinePolicy' }],
    reserved: true,
  },
  'admin:audio-pipeline:manage': {
    description: 'Manage audio pipeline configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'AsrPipeline' }],
    reserved: true,
  },
  'admin:platform-metrics:read': {
    description: 'Read platform-wide metrics',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PlatformMetrics' }],
    reserved: true,
  },
  'admin:prompt-template:manage': {
    description: 'Manage prompt templates from the admin surface',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PromptTemplate' }],
    reserved: true,
  },
  'admin:pstudio:manage': {
    description: 'Manage Prisma Studio access',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'PrismaStudio' }],
    reserved: true,
  },
  'admin:queue:manage': {
    description: 'Manage background job queues',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:scheduler:manage': {
    description: 'Manage scheduled jobs',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'all' }],
    reserved: true,
  },
  'admin:rbac-policy:write': {
    description: 'Manage RBAC policies (HIGH sensitivity — defines the RBAC model itself)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Policy' }],
    reserved: true,
  },
  'admin:resource-subscription:manage': {
    description: 'Manage resource subscriptions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'ResourceSubscription' }],
    reserved: true,
  },
  'admin:service-release:manage': {
    description: 'Manage service release registrations',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'TenantTelemetry' }],
    reserved: true,
  },
  'admin:storage-key:manage': {
    description: 'Manage tenant storage access keys (HIGH sensitivity — storage credentials)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Tenant' }],
    reserved: true,
  },
  'admin:transcription-job:read': {
    description: 'Read admin transcription job status',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'AsrPipeline' }],
    reserved: true,
  },
  'admin:allowed-origin:manage': {
    description: 'Manage tenant CORS allow-list',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantAllowedOrigin' }],
    reserved: true,
  },
  'admin:tenant-storage:manage': {
    description: 'Manage tenant storage buckets and config',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'Tenant' }],
    reserved: true,
  },
  'admin:tenant-frontend-config:manage': {
    description: 'Manage tenant frontend configuration',
    category: 'Admin',
    implies: [{ action: 'update', subject: 'Tenant' }],
    reserved: true,
  },
  'admin:tenant-idp-config:manage': {
    description: 'Manage tenant identity-provider config (HIGH sensitivity — SSO)',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantIdentityProvider' }],
    reserved: true,
  },
  'admin:tenant-stt-config:manage': {
    description: 'Manage tenant STT configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantSttConfig' }],
    reserved: true,
  },
  'admin:tenant-tts-config:manage': {
    description: 'Manage tenant TTS configuration',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'TenantTtsConfig' }],
    reserved: true,
  },
  'admin:workflow-run:read': {
    description: 'Read admin workflow runs',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'WorkflowRun' }],
    reserved: true,
  },
  'admin:workflow-test-fixture:manage': {
    description: 'Manage workflow test fixtures',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'WorkflowTestFixture' }],
    reserved: true,
  },
  'admin:workflow-definition:manage': {
    description: 'Author, validate and publish workflow definitions',
    category: 'Admin',
    implies: [{ action: 'manage', subject: 'WorkflowDefinition' }],
    reserved: true,
  },
  'admin:workflow-node:read': {
    description: 'Read the code-owned workflow node-type registry',
    category: 'Admin',
    implies: [{ action: 'read', subject: 'WorkflowDefinition' }],
    reserved: true,
  },

  // Workflow exposure plane (TASK-722). Prefix-matching (apikey.service.ts's
  // hasScope) means a key holding the bare `"workflow"` scope would grant all
  // three below — that is the existing prefix semantics, not new behavior.
  // NOTE: these scopes exist so `@RequiredScopes(...)` can be declared once
  // the gateway controller lands; the surface itself ships OFF (kill-switch)
  // per TASK-722 R-1 until TASK-708's scope-narrowing exit criterion is met.
  'workflow:definition:read': {
    description: 'List published workflows and their input schemas',
    category: 'Workflow',
    implies: [{ action: 'list', subject: 'WorkflowDefinition' }],
  },
  'workflow:run:write': {
    description: 'Invoke and cancel workflow runs',
    category: 'Workflow',
    implies: [
      { action: 'create', subject: 'WorkflowRun' },
      { action: 'update', subject: 'WorkflowRun' },
    ],
  },
  'workflow:run:read': {
    description: 'Read workflow run status and stream progress',
    category: 'Workflow',
    implies: [{ action: 'read', subject: 'WorkflowRun' }],
  },

  // Wildcards
  'stt:*': { description: 'Full STT service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'tts:*': { description: 'Full TTS service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'consultation:*': { description: 'Full consultation access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'ai:*': { description: 'Full AI inference access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'tenant:*': { description: 'Full tenant self-service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'user:*': { description: 'Full user self-service access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'media:*': { description: 'Full media access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  'admin:*': { description: 'Full admin access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */, reserved: true },
  'webhook:*': {
    description: 'Full webhook access',
    category: 'Wildcard',
    implies: [] /* expanded — see resolveImpliedPermissions */,
    reserved: true,
  },
  'workflow:*': { description: 'Full workflow exposure access', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
  '*': { description: 'Unrestricted access (superadmin only)', category: 'Wildcard', implies: [] /* expanded — see resolveImpliedPermissions */ },
};

export function isValidScope(scope: string): boolean {
  return scope in API_KEY_SCOPE_REGISTRY;
}

/**
 * TASK-757 (policy A2) — is this scope RESERVED, i.e. known but no longer
 * grantable?
 *
 * Deliberately NOT folded into `isValidScope`: the two answer different
 * questions and conflating them would break stored keys. `isValidScope` is
 * "is this a string the platform recognises?" and must stay `true` for a
 * reserved scope, or an existing key carrying `admin:*` would fail validation
 * on a `PATCH` that never touched its scopes. `isReservedScope` is "may this be
 * granted NOW?" and is the one that says no.
 *
 * An UNKNOWN string is not reserved — membership is `isValidScope`'s job, and
 * answering `true` here for a typo would produce a misleading error message.
 */
export function isReservedScope(scope: string): boolean {
  return API_KEY_SCOPE_REGISTRY[scope]?.reserved === true;
}

/**
 * TASK-756 — resolve the full set of CASL permissions a scope implies.
 *
 * Wildcards resolve by EXPANSION, not by a literal permission of their own,
 * because that is exactly what they buy at request time (`ApiKeyService.hasScope`:
 * `'*'` grants everything, `'<ns>:*'` grants the whole namespace):
 *
 * - `'<ns>:*'` → the union across every registry key starting `'<ns>:'`
 * - `'*'`      → the union across the whole registry (so only `manage:all`
 *                satisfies it)
 *
 * Enumeration is by KEY, never by position: `'admin:*'` does not sit inside the
 * contiguous `admin:` block in this file, so anything walking a line range or a
 * block would miss the single most dangerous string in the registry.
 *
 * Throws on an unknown scope — fail closed. Resolving an unrecognized string to
 * "no requirement" would turn a typo into a ceiling bypass.
 */
export function resolveImpliedPermissions(scope: string): ImpliedPermission[] {
  const collected: ImpliedPermission[] = [];

  if (scope === '*') {
    for (const [key, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
      if (key !== '*') collected.push(...def.implies);
    }
  } else if (scope.endsWith(':*')) {
    if (!(scope in API_KEY_SCOPE_REGISTRY)) {
      throw new Error(`Unknown API key scope: ${scope}`);
    }
    const prefix = `${scope.slice(0, -1)}`; // 'admin:*' -> 'admin:'
    for (const [key, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
      if (key !== scope && key.startsWith(prefix)) collected.push(...def.implies);
    }
  } else {
    const def = API_KEY_SCOPE_REGISTRY[scope];
    if (!def) {
      throw new Error(`Unknown API key scope: ${scope}`);
    }
    collected.push(...def.implies);
  }

  const seen = new Set<string>();
  return collected.filter((permission) => {
    const key = `${permission.action}:${permission.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The GRANTABLE catalog. Reserved scopes (TASK-757) are omitted: the platform
 * will always refuse to mint a key carrying one, so advertising them would
 * offer access that can never be issued.
 */
export function getAvailableScopes(): Array<{ scope: string } & ScopeDefinition> {
  return Object.entries(API_KEY_SCOPE_REGISTRY)
    .filter(([, def]) => def.reserved !== true)
    .map(([scope, def]) => ({
      scope,
      ...def,
    }));
}

/**
 * What `GET /api/v1/admin/api-keys/scopes` returns. Reserved scopes are
 * omitted, which empties the `Admin` and `Webhook` categories entirely — so
 * neither category appears at all, rather than appearing empty.
 */
export function getScopesByCategory(): Record<string, Array<{ scope: string; description: string }>> {
  const result: Record<string, Array<{ scope: string; description: string }>> = {};
  for (const [scope, def] of Object.entries(API_KEY_SCOPE_REGISTRY)) {
    if (def.reserved === true) continue;
    if (!result[def.category]) result[def.category] = [];
    result[def.category].push({ scope, description: def.description });
  }
  return result;
}
