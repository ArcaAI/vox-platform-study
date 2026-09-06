/**
 * Tenant-Scope Prisma `$extends` Extension.
 *
 * This extension injects `tenantId` from a caller-supplied context
 * provider into every read/write against a tenant-scoped model. It is
 * the second line of defence behind the database-level Row-Level
 * Security policies; together they form the "defence in depth"
 * multi-tenancy posture mandated by the audit
 * (`docs/multi-tenancy-audit/02-prisma-schema-review.md`).
 *
 * Composition: applied AFTER `applySoftDeleteExtension` so the
 * tenant filter sees the soft-delete-augmented args (Prisma runs the
 * outermost extension first; the chain is
 *   prisma -> softDelete -> tenantScope -> engine
 * which means the tenantScope handler runs first, merges `tenantId`
 * into `args.where`, then hands off to the soft-delete handler which
 * adds `resourceStatus: { not: 'DELETED' }` on the same `where`).
 *
 * Out-of-scope (kept invisible to NestJS callers):
 *   - Cross-aggregate tenant equality (parent.tenantId vs child) —
 *     handled by application-layer guards.
 *   - `SET LOCAL app.tenant_id` for RLS — owned separately.
 */

import { PrismaClient } from '../generated/core-prisma-client/client.js';

// ---------------------------------------------------------------------------
// Allow-list of tenant-scoped models
// ---------------------------------------------------------------------------

/**
 * Models that carry a `tenantId` column in `packages/database/src/prisma/db_main/*.prisma`.
 *
 * This list mirrors SCHEMA REALITY — every model here has a `tenantId`
 * scalar, so the extension only ever injects `tenantId` on a column that
 * actually exists.
 *
 * The `User*` identity tables (`User`, `UserProfile`, `UserSettings`,
 * `UserMedia`) are deliberately NOT here: `User` is a global, multi-tenant
 * identity. A user's membership in a tenant is modeled by the two
 * tenant-scoped JOIN tables — `UserRoleAssignment` (role) and
 * `UserDepartment` (department) — both of which ARE in this list.
 * `UserVoiceProfile` is the one exception: it is biometric PHI, so each
 * profile is stamped with its enrollment tenant and scoped like any other
 * PHI-bearing model (a user working in multiple tenants enrolls per tenant).
 *
 * `UserDepartment` is in this list (added 2026-06-02) so its reads/writes
 * are tenant-injected like every other tenant-scoped model; an earlier
 * design considered adding `tenantId` directly to the `User*` tables
 * instead, but that would have been the wrong call.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  // consultation.prisma (7)
  'Consultation',
  'ContextItem',
  'ContextItemVersion',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
  'Highlight', // doctor-authored highlight
  // audit.prisma (1)
  'AuditLog',
  // webhook.prisma (1)
  'Webhook',
  // notification.prisma (2)
  'Notification',
  'ResourceSubscription',
  // tag.prisma (1)
  'Tag',
  // rbac.prisma —: `Role` is now genuinely tenant-scoped.
  // SYSTEM-tenant rows are the platform's built-in roles (TENANT_ADMIN,
  // DOCTOR, NURSE, ...) — every tenant resolves them directly (also a
  // SYSTEM-shared read model, below) rather than getting its own clone.
  // Tenant rows are custom roles a tenant admin created via
  // `POST /admin/rbac/roles` or `:id/clone`. `Policy`/`RolePolicy` stay
  // OMITTED_MODELS / globally unscoped — see the schema comment on `Role`
  // in rbac.prisma for why.
  'Role',
  // service-account.prisma — `ServiceAccount` is NOT here either, for exactly
  // the reason below: the token exchange reads it by `clientId` PRE-AUTH.
  // apikey.prisma — `ApiKey` is NOT here; it is INTENTIONALLY_UNSCOPED (see
  // the drift-guard test). API-key AUTHENTICATION must read the row by
  // keyHash before any principal — and therefore any tenant — exists, the
  // same pre-auth shape that already exempts `TenantEntitlement`.
  // globalSetting.prisma (1)
  'GlobalSetting',
  // stt.prisma (4)
  'AsrPipeline',
  'AsrPipelineVersion', // version-history child of AsrPipeline
  'AiModel',
  'TranscriptionJob',
  // department.prisma (1)
  'Department',
  // user.prisma (3)
  'UserRoleAssignment',
  'UserDepartment',
  // Biometric voice profile, stamped with the enrollment tenant so
  // reads/writes are tenant-scoped like every other PHI-bearing model (the
  // STT preseed path applies the same filter in raw SQL).
  'UserVoiceProfile',
  // dna-writing-style.prisma (4)
  'DnaWritingStyleReport',
  'DnaWritingStyleVersion',
  'DnaUsageRecord',
  'PromptUsageRecord',
  // prompt-template.prisma (2)
  'PromptTemplate',
  'PromptVersion',
  // tenant-bucket.prisma (3)
  'TenantBucket',
  'StorageAccessKey',
  'TenantStorageConfig',
  // tenant.prisma (1)
  'TenantFrontendConfig', // per-tenant frontend pipeline config
  // media.prisma (1)
  'Media',
  // harness.prisma (7) — clinical-documentation harness
  'GoldenSet',
  'GoldenCase',
  'EvalRun',
  'EvalScore',
  'HarnessAuditEvent', // append-only WORM audit (no soft-delete; see client.ts)
  // Harness Administration Console: editable runtime policy.
  'HarnessPolicy', // also a SYSTEM-shared read model (global-default row, below)
  'HarnessPolicyChange', // append-only WORM change log (no soft-delete)
  // knowledge.prisma (2) — institutional RAG corpus
  'KnowledgeDocument',
  'KnowledgeChunk',
  // tenant-tts-config.prisma is GONE (TASK-888): TenantTtsConfig was retired
  // once the speech path became agent-first — every field it carried maps onto
  // the TEXT_TO_SPEECH Agent or an AiProviderConnection(service='tts') row,
  // which is also where the earlier TenantTtsProviderCredential rows went.
  // tenant-stt-config.prisma (1) — per-tenant STT fallback config. The former
  // per-(tenant,provider) BYO-credential model, TenantSttProviderCredential,
  // was DROPPED in — those rows now live in the unified
  // AiProviderConnection plane (service='stt').
  'TenantSttConfig', // also a SYSTEM-shared read model (platform-default row, below)
  // tenant-nlp-task-instructions.prisma (1) — tenant-writable topic/intent
  // instruction content for nlp.topic/nlp.intent. Deliberately NOT
  // a SYSTEM-shared read model — there is no platform default; a plain
  // per-tenant resource (the TenantFrontendConfig pattern).
  'TenantNlpTaskInstructions',
  // ai-provider-connection.prisma (1) — config-plane core. WHERE a
  // serving provider lives + HOW to authenticate. SYSTEM row = platform
  // default; tenant rows are BYO cloud credentials (azure/bedrock only,
  // service-enforced). Secret-bearing (`encryptedApiKey`), and IS
  // SYSTEM-shared for reads — see the justification on the
  // SYSTEM_SHARED_READ_MODELS entry below.
  'AiProviderConnection',
  // ai-routing-policy.prisma (1) — config-plane core ( The
  // ORDERED N-way candidate chain per (tenant, taskKey, policyVersion): which
  // providers serve a task, in what order, and what may happen on failure.
  // SYSTEM row = platform default; a tenant row wins on presence. Carries no
  // secret (a candidate names a connection by reference; the credential stays
  // in AiProviderConnection). Also a SYSTEM-shared read model — see the
  // SYSTEM_SHARED_READ_MODELS entry below.
  'AiRoutingPolicy',
  // entitlement.prisma (1) — rolling-monthly usage meters. The
  // reconcile job reads/writes these via the UNSCOPED `baseClient` (explicit
  // tenantId filters, no CLS — same escape hatch as the audit-retention
  // purge), so scoping here is behaviour-neutral for it while protecting any
  // future extended-client/repository access. `TenantEntitlement` is NOT
  // here — see INTENTIONALLY_UNSCOPED in the drift-guard test (pre-auth
  // throttler + super-admin cross-tenant override CRUD read it through the
  // extended client without a matching CLS tenant).
  'TenantUsageMeter',
  // entitlement.prisma (1) — append-only plan-change history (#6).
  // Tenant-scoped and NOT SYSTEM-shared: a tenant's plan timeline is its own.
  // Soft-delete EXEMPT (append-only fact, no resourceStatus column) — see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts.
  'TenantPlanHistory',
  // identity-provider.prisma (3) — tenant-scoped external OIDC IdP.
  // None are SYSTEM-shared reads — a tenant's IdP config/links/domains are
  // never visible cross-tenant.
  'TenantIdentityProvider',
  'FederatedIdentity',
  'TenantIdentityProviderDomain',
  // guardrail-availability.prisma (1) — per-tenant guardrail AVAILABILITY
  // (TASK-886): WHICH screening policies apply to a tenant. SYSTEM row = the
  // platform default set; a tenant row wins on presence, and ABSENCE (or an
  // empty selection) inherits SYSTEM — there is no "off".
  //
  // Deliberately NOT a SYSTEM_SHARED_READ_MODEL. The widening to SYSTEM is
  // performed by the RESOLVERS — `GuardrailAvailabilityService.resolve` on the
  // gateway and `TenantConfigResolver.resolve` in `apps/guardrail` — which
  // must be able to tell "the tenant has a row" from "the tenant has none" in
  // order to widen on ABSENCE ONLY. A shared read would fold both tiers into
  // one result set and make that distinction unavailable, which is the same
  // reason `ConsultationContextSchema` records for staying unshared.
  'TenantGuardrailPolicy',
  // agent-trajectory.prisma (1) — ordered session trajectory.
  // Tenant-scoped ops telemetry (per-session step stream). NOT SYSTEM-shared —
  // a tenant's trajectory is never visible cross-tenant. It is soft-delete
  // EXEMPT (retention-pruned, no resourceStatus column) — see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts.
  'AgentTrajectoryStep',
  // mcp-server.prisma — external-tools registry. A STANDARD tenant-
  // scoped config model (tenantId + resourceStatus soft-delete + _version OCC +
  // audit). SYSTEM-tenant rows are the shared registry every tenant's harness
  // run READS to resolve a server (also a SYSTEM-shared read model below);
  // WRITES stay SYSTEM-only (super-admin, service layer).
  'McpServer',
  // consultation.prisma — segment-level transcript structure. A
  // per-transcript annotation table (like NamedEntity / AudioRecording),
  // tenant-scoped and soft-delete EXEMPT (no resourceStatus column; segments
  // live/die with their parent transcript) — see MODELS_WITHOUT_SOFT_DELETE.
  'TranscriptSegment',
  // consultation.prisma. Per-section rows of a live-generated
  // clinical document. Tenant-scoped and soft-delete EXEMPT for the same reason
  // TranscriptSegment above is: sections live and die with their consultation's
  // document. Deliberately NOT SYSTEM-shared — a section is PHI.
  'DocumentSection',
  // harness.prisma — gate-edit mining store. A derived, append-only
  // learning corpus. Tenant-scoped and NOT SYSTEM-shared: one tenant's mined
  // exemplars must never surface in another tenant's few-shot retrieval. It is
  // soft-delete EXEMPT (no resourceStatus column) — see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts.
  'GateEditExemplar',
  // department-agent.prisma — immutable cross-tenant promotion records
  // . `tenantId` IS the TARGET tenant, so the target owns and reads
  // its own agent lineage while the source tenant's id survives only as the
  // plain `fromTenantId` column. Emphatically NOT SYSTEM-shared: widening this
  // would let any tenant enumerate which agents moved between which tenants.
  'AgentPromotion',
  // usage-ledger.prisma (5) — AI usage metering plane.
  // The ledger, its outbox and both rollups are tenant-scoped and NOT
  // SYSTEM-shared: one tenant's consumption (and therefore its cost profile)
  // must never surface in another's reads. All four are soft-delete EXEMPT
  // (append-only under hard retention, no resourceStatus column) — see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts.
  'AiUsageEvent',
  'AiUsageOutbox',
  'AiUsageRollupHourly',
  'AiUsageRollupDaily',
  // The price book is the ONE exception in this group: its SYSTEM-tenant rows
  // are the platform rate card that every tenant's rater must read, so it is
  // also a SYSTEM-shared read model (below). Standard soft-delete + sys-events
  // (it is admin-managed, unlike its append-only siblings).
  'AiPriceBook',
  // billing.prisma (3) — tenant invoice plane.
  // Money documents: strictly tenant-scoped, never SYSTEM-shared.
  // BillingInvoice/Line keep soft delete (a draft is withdrawn, not purged);
  // BillingAdjustment is append-only (a credit memo against a FINALIZED,
  // immutable period cannot be retracted by deletion) and is therefore listed
  // in MODELS_WITHOUT_SOFT_DELETE.
  'BillingInvoice',
  'BillingInvoiceLine',
  'BillingAdjustment',
  // tenant-allowed-origin.prisma — CORS control plane. A STANDARD
  // tenant-scoped config model (tenantId + resourceStatus soft-delete +
  // _version OCC + audit). Admin CRUD stays tenant-filtered; SYSTEM-owned rows
  // (platform-operated origins, valid for every tenant) are resolved by the
  // application-layer OriginRegistryService, not by widening this read here.
  'TenantAllowedOrigin',
  // platform.prisma — Service Version & Release Registry. All
  // four are platform-wide (SYSTEM tenant), EXCEPT UserChangelogAcknowledgement
  // which is scoped to the acknowledging user's own tenant.
  'ServiceRelease',
  'ServiceInstance',
  'ChangelogEntry',
  'UserChangelogAcknowledgement',
  // consultation-context-schema.prisma — tenant-declared consultation context
  // kinds. BOTH the mutable head and its immutable version
  // snapshots are ordinary tenant-owned rows; they are deliberately NOT added
  // to SYSTEM_SHARED_READ_MODELS — a tenant reads only its own schemas, and
  // the golden-library clone path copies rows rather than sharing
  // them, exactly as `DepartmentAgent` does.
  'ConsultationContextSchema',
  'ConsultationContextSchemaVersion',
  // document-template.prisma — the tenant's clinical-document SHAPE catalog
  // BOTH the mutable head and its immutable version snapshots are
  // ordinary tenant-owned rows, deliberately NOT added to
  // SYSTEM_SHARED_READ_MODELS: a tenant reads only its own templates, and the
  // platform's SOAP/discharge shapes reach a tenant by the golden-library CLONE
  // path, never by a shared read — exactly the posture
  // `ConsultationContextSchema` records above.
  'DocumentTemplate',
  'DocumentTemplateVersion',
  // workflow-definition.prisma — the workflow substrate's persistence floor
  // Rows ARE versions (no separate head/version split).
  // Deliberately NOT added to SYSTEM_SHARED_READ_MODELS: a tenant reads
  // only its own definitions, and the SYSTEM-tenant platform-default rows
  // reach a tenant via the seed's clone path, not shared read — the same
  // posture ConsultationContextSchema records above.
  'WorkflowDefinition',
  // consent.prisma — ordinary tenant-owned rows, keyed
  // (tenantId, externalPatientId, purpose). No SYSTEM row and no widening:
  // a tenant reads/writes only its own consent grants.
  'ConsentGrant',
  // workflow-run.prisma — the runs/observability read model.
  // Tenant-scoped ops telemetry (one row per run), NOT SYSTEM-shared — a
  // tenant's runs are never visible cross-tenant. Soft-delete EXEMPT (hard
  // retention, no resourceStatus column) — see MODELS_WITHOUT_SOFT_DELETE.
  'WorkflowRun',
  // workflow-webhook.prisma (TASK-864) — the inbound webhook trigger's
  // per-definition secret, keyed (tenantId, workflowSlug). Ordinary
  // tenant-owned rows, NOT SYSTEM-shared: a signing key is never a platform
  // default. Keeps soft delete.
  'WorkflowWebhookSecret',
  // workflow-test-fixture.prisma — per-tenant saved synthetic Workbench
  // inputs. Ordinary tenant-owned rows, NOT SYSTEM-shared — a
  // tenant's fixtures are never visible cross-tenant. Keeps soft delete
  // (NOT in MODELS_WITHOUT_SOFT_DELETE).
  'WorkflowTestFixture',
  // workflow-assignment.prisma — WHICH workflow definition governs a
  // tenant/department for a palette. Ordinary tenant-owned rows.
  // Deliberately NOT in SYSTEM_SHARED_READ_MODELS: the platform-default tier
  // is the tenant's OWN active published definition for the palette (the
  // seed's clone path), never a SYSTEM-tenant assignment row read
  // cross-tenant — the same posture WorkflowDefinition records above.
  'WorkflowAssignment',
  // Its append-only WORM change log (no soft-delete; see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts).
  'WorkflowAssignmentChange',
  // workflow-invariant-rule.prisma — the validator's rule rows.
  // ALSO a SYSTEM-shared read model (below): a tenant reads its own rows AND
  // the SYSTEM platform rule set, never writes to a SYSTEM-owned row.
  'WorkflowInvariantRule',
  // rate-limit.prisma — the rate-limit rule config plane. A
  // SYSTEM-tenant row is a platform-wide per-route limit; a customer-tenant row
  // overrides it for that tenant alone.
  //
  // Deliberately NOT added to SYSTEM_SHARED_READ_MODELS, unlike the other
  // "SYSTEM row is the platform default" models above. Nothing resolves these
  // rows under a tenant's CLS: `TieredThrottlerGuard` reads an in-memory cache
  // that `RateLimitRuleCache` loads inside `clsService.exit(...)` (the
  // fix, so an in-request invalidation cannot poison it with one tenant's view),
  // and there is no tenant-facing read surface — every rule route is
  // `manage all`. Widening reads here would buy no consumer anything.
  'RateLimitRule',
  // TASK-863 — the first-class Agent substrate. All four are PLAIN tenant-scoped: TASK-890
  // step v removed `Agent` and `AgentAssignment` from the shared-read set, because an agent is
  // CONTENT and a tenant runs its own provisioned clone of a platform agent rather than reading
  // SYSTEM's row (see the note under SYSTEM_SHARED_READ_MODELS).
  'Agent',
  'AgentModelFallback',
  'AgentAssignment',
  'AgentAssignmentChange',
]);

/**
 * `model` arrives via `$allModels` in both Pascal and camel case
 * depending on which Prisma surface dispatched the query. Accept both.
 */
export function isTenantScopedModel(model: string): boolean {
  if (TENANT_SCOPED_MODELS.has(model)) return true;
  const pascal = model.charAt(0).toUpperCase() + model.slice(1);
  return TENANT_SCOPED_MODELS.has(pascal);
}

// ---------------------------------------------------------------------------
// SYSTEM-tenant read inheritance
// ---------------------------------------------------------------------------

/**
 * Reserved system tenant that owns platform-wide catalog rows (NOT customer
 * data). Mirrors `SYSTEM_TENANT_ID` in
 * `packages/database/src/prisma/db_main/seed/00-constants.ts`; duplicated here
 * as a literal so the extension carries no dependency on the seed module.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Subset of TENANT_SCOPED_MODELS whose SYSTEM-tenant rows are a shared,
 * read-only platform catalog that EVERY tenant is allowed to read (e.g. the
 * seeded production ASR pipelines / AI models in `seed/06-stt.ts`, all owned
 * by `SYSTEM_TENANT_ID`).
 *
 * For these models a READ widens the tenant filter to
 * `tenantId IN [caller, SYSTEM]` so a customer tenant can resolve the shared
 * catalog entry it references (e.g. `POST /audio/transcription-jobs` validates
 * its `pipelineId` against the SYSTEM-owned pipeline before persisting a
 * tenant-owned job).
 *
 * SCOPE IS DELIBERATELY NARROW — only platform catalog tables belong here:
 *   - Reads still EXCLUDE every other tenant's rows (the `IN` list is exactly
 *     [caller, SYSTEM]), so cross-customer isolation is unchanged.
 *   - WRITES are NOT widened (see makeReadHandler vs the mutation handlers):
 *     a tenant can read but never create/update/delete a SYSTEM-owned row.
 *   - Customer-data models (Consultation, TranscriptionJob, TenantBucket, …)
 *     are intentionally absent — their cross-tenant 404 contracts must hold.
 */
export const SYSTEM_SHARED_READ_MODELS: ReadonlySet<string> = new Set([
  'AsrPipeline',
  'AiModel',
  // the platform's built-in roles (TENANT_ADMIN, DOCTOR,
  // NURSE, SUPER_ADMIN, ...) are SYSTEM-tenant rows every tenant must read
  // directly to function at all (RolesController listing, `:id/clone`
  // source lookup, member counts) — the same "every tenant resolves the
  // SYSTEM row" shape as `AiTaskDefault`/`HarnessPolicy` below, NOT a
  // per-tenant clone. READS widen to [caller, SYSTEM] so a tenant sees the
  // built-ins plus its own custom roles, never another tenant's; WRITES are
  // NOT widened, so a tenant admin's `update`/`patch`/`softDelete` on a
  // SYSTEM role id matches zero rows under the tenant-pinned `where` (service
  // layer already refuses this via the `isSystemRole` guard before the write
  // is attempted). A super admin mutating a SYSTEM role routes through the
  // unscoped base client instead (`RbacRoleService`'s cross-tenant lane,
  // mirroring `AiTaskDefaultService.crossTenantLane`) so it succeeds
  // regardless of any working tenant they have selected.
  'Role',
  // The harness GLOBAL-DEFAULT policy row is owned by the
  // SYSTEM tenant and every tenant must read it to compute its effective policy
  // (tenant row merged over the system default). A READ therefore widens to
  // `tenantId IN [caller, SYSTEM]`; WRITES are NOT widened, so a tenant can read
  // but never mutate the SYSTEM-owned global default (only a platform admin can,
  // through the dedicated global-default service path).
  'HarnessPolicy',
  // The per-tenant STT PLATFORM-DEFAULT row is owned by the SYSTEM
  // tenant and read by every tenant's getEffective (tenant row merged over the
  // SYSTEM default). READS widen to [caller, SYSTEM]; WRITES are NOT widened
  // (only a platform admin mutates the SYSTEM default). This model never
  // carries a secret — BYO credentials live in AiProviderConnection
  // (service='stt'; see its own CAVEAT below for how ITS widening stays safe).
  'TenantSttConfig',
  // The provider CONNECTION catalog: the SYSTEM row records where a
  // serving provider lives and (as Vault-Transit ciphertext) how to auth to it.
  // Every tenant's `resolveConnection` cascade (tenant row → SYSTEM row → env)
  // runs under tenant CLS at request time and would otherwise read nothing.
  // READS widen to [caller, SYSTEM]; WRITES are NOT widened.
  //
  // CAVEAT — this is the first SECRET-BEARING model in this list. It is safe
  // because the widening is [caller, SYSTEM] only (never another tenant's BYO
  // row), the `encryptedApiKey` ciphertext is inert without gateway-side
  // Vault-Transit decrypt, and NO read DTO ever carries it (`hasKey` boolean
  // only). This is the unified plane for LLM/STT/TTS BYO credentials
  // (`service` discriminator) — dropped the former per-capability
  // `TenantTtsProviderCredential` / `TenantSttProviderCredential` tables,
  // which had no SYSTEM row at all, so widening them would have bought
  // nothing.
  'AiProviderConnection',
  // The provider ROUTING policy ( The SYSTEM-tenant row is the
  // platform default candidate chain every tenant without its own row must
  // resolve — the identical "tenant row → SYSTEM row" shape as AiTaskDefault
  // above, and the resolver runs under the caller's own tenant CLS at request
  // time, so without the widening it reads nothing and every such tenant fails
  // closed. READS widen to [caller, SYSTEM]; WRITES are NOT widened (policy
  // authoring under SYSTEM is super-admin-only at the service layer, the
  // AiTaskDefault precedent). No secrets on the model — candidates reference a
  // connection, they do not carry its credential.
  'AiRoutingPolicy',
  // the MCP external-tools registry: server rows are registered by a
  // super admin under the SYSTEM tenant and every tenant's harness run must
  // READ the shared registry to resolve a server it references (server metadata
  // only — `authRef` is a Vault PATH, never secret material). READS widen to
  // [caller, SYSTEM]; WRITES are NOT widened (registry mutation is super-admin
  // only at the service layer, the guardrail.* precedent).
  'McpServer',
  // The release registry and the curated changelog are PLATFORM
  // facts owned by the SYSTEM tenant, read by callers acting under their own
  // tenant CLS. Without widening, `/changelog` and `/changelog/unseen` return
  // NOTHING for every tenant user, and `/releases` returns nothing for a
  // TENANT_ADMIN (or a super admin who has a working tenant selected) — the
  // rows exist, the reader just never sees them. Found by U10 during
  // implementation; it affects all three models, not only the changelog.
  // READS widen to [caller, SYSTEM]; WRITES are NOT widened — release rows are
  // written only by the service-token registration path, and changelog
  // authoring is super-admin-only, enforced imperatively in ChangelogService.
  // No secret material: these carry versions, commit SHAs and release notes.
  //
  // `UserChangelogAcknowledgement` is deliberately NOT here — an
  // acknowledgement is genuinely the acknowledging user's own tenant's row,
  // and widening it would let one tenant observe another's read state.
  'ServiceRelease',
  'ServiceInstance',
  'ChangelogEntry',
  // The PLATFORM-DEFAULT storage row (SYSTEM tenant, `bucketId IS NULL`) is the
  // third step of the model's own resolution order
  // (bucket row → tenant default → SYSTEM default → env). Every tenant's
  // upload/download path resolves it at request time under that tenant's CLS,
  // so without widening the read the row is invisible and the platform silently
  // falls back to env — the exact failure mode documented for GlobalSetting
  // below. READS widen to [caller, SYSTEM]; WRITES are NOT widened (only a
  // super admin mutates the platform default, enforced imperatively in
  // `TenantStorageConfigService`). No secret material is shared: the row
  // carries only a `credentialsRef` Vault PATH, never credentials (same posture
  // as McpServer's `authRef`).
  'TenantStorageConfig',
  // Platform infrastructure settings (S3/MinIO endpoint + credentials, STT
  // pipeline slugs/queues, …) are seeded under the SYSTEM tenant in
  // `seed/06-stt.ts`, alongside the SYSTEM-owned AsrPipeline/AiModel catalog.
  // `AppSettingsService` builds ONE process-wide, tenant-agnostic settings
  // cache via `globalSettingRepository.findAll({})`; when that load runs under
  // the platform (GLOBAL) tenant context, an exact-match filter drops these
  // SYSTEM rows, leaving e.g. `S3_ENDPOINT` empty so the S3 client defaults to
  // real AWS (InvalidAccessKeyId 500 on bucket ops). Widening READS to
  // [caller, SYSTEM] lets the platform load resolve these shared settings.
  // WRITES are NOT widened (a tenant can never mutate a SYSTEM-owned setting),
  // and customer tenants stay excluded (the IN list is exactly [caller, SYSTEM]).
  'GlobalSetting',
  // The PLATFORM RATE CARD. Both price planes — COST (COGS,
  // consumed by the at-ingest rater) and SELL (the tenant-facing card,
  // consumed by the invoice engine) — live as SYSTEM-tenant rows. Every
  // tenant's rater resolves "the row effective at this event's occurredAt"
  // while running under that tenant's CLS, so without widening the read the
  // rate card is invisible and nothing can be priced (the same silent-fallback
  // failure mode documented for GlobalSetting above). READS widen to
  // [caller, SYSTEM]; WRITES are NOT widened — rate-card mutation is
  // SUPER_ADMIN-only at the service layer (the AiTaskDefault precedent), and a
  // tenant-owned row is reserved for a negotiated enterprise rate. No secret
  // material: prices are integer micros.
  'AiPriceBook',
  // workflow-invariant-rule.prisma. The SYSTEM-tenant rows ARE the
  // platform invariant register made executable; every tenant's
  // `WorkflowValidatorService` must read them (merged with its own
  // additions) to validate ANY graph, the same "every tenant must resolve
  // the SYSTEM row to function at all" shape as `HarnessPolicy`/
  // `HarnessPolicy` above — without widening, a tenant validating its own
  // graph would see only the rules IT authored (or none), silently
  // under-enforcing the platform's own safety rules. READS widen to
  // [caller, SYSTEM] (`findApplicable()` issues two explicit-tenantId reads,
  // mirroring `HarnessPolicyRepository`'s SYSTEM-default read); WRITES are NOT
  // widened — a tenant can read but never mutate a SYSTEM-owned rule row
  // (the one-way-strictness rule enforced in the service).
  'WorkflowInvariantRule',
]);

/**
 * TASK-890 L13 step v (OD-M) — WHAT LEFT THIS SET, and why it can never come back.
 *
 * `Agent`, `AgentAssignment`, `PromptTemplate` and `PromptVersion` were members. They are
 * CONTENT, and the owner rule (§1.5) is that **content is CLONED and config CASCADES**: the
 * SYSTEM tenant holds a REFERENCE SET that `TenantReferenceSetService` copies into a tenant at
 * creation, not a tier a runtime read widens into. Every entry that remains above is CONFIG —
 * a catalogue, a policy, a platform setting — where widening on ABSENCE is exactly right.
 *
 * The difference is what a MISS means. A widened content read answered a tenant's question with
 * the PLATFORM's row, and did it silently: a tenant with no assignment ran the platform's agent
 * and could neither see nor edit the thing serving its clinicians. After the flip a miss is a
 * NAMED, fail-closed error — `AGENT_NOT_ASSIGNED`, `PROMPT_DEFAULT_NOT_PROVISIONED`,
 * `LEGACY_CONTEXT_SCHEMA_MISSING` — each naming the tenant and the remedy (a re-sync).
 *
 * Three content models were never here for the same reason, and their comments above say so:
 * `ConsultationContextSchema` / `…Version`, `DocumentTemplate` / `…Version` and
 * `WorkflowDefinition`. The four that just left join them.
 *
 * Re-adding any of them would restore the silent read. The reads that must still see the
 * reference set say so EXPLICITLY on the unscoped client instead —
 * `AgentRepository.findSystemReferences` / `findSystemReferenceBySlug`,
 * `PromptTemplateRepository.findSystemReferenceById`, and the older
 * `WorkflowDefinitionRepository.findCloneSource` / `findSystemTemplates` they were copied from —
 * and they are consumed by provisioning and the super-admin library screens only.
 */

export function isSystemSharedReadModel(model: string): boolean {
  if (SYSTEM_SHARED_READ_MODELS.has(model)) return true;
  const pascal = model.charAt(0).toUpperCase() + model.slice(1);
  return SYSTEM_SHARED_READ_MODELS.has(pascal);
}

// ---------------------------------------------------------------------------
// Context provider — singleton registered by the host application
// ---------------------------------------------------------------------------

/**
 * Pluggable provider that returns the *current* tenant id (typically
 * from `nestjs-cls`) and optionally signals whether the caller carries
 * the SUPER_ADMIN role (cross-tenant audit / platform-admin paths).
 *
 * The provider is intentionally framework-agnostic so this package
 * does not have to depend on `nestjs-cls`. NestJS wires its CLS-backed
 * implementation in `apps/api/src/database/tenant-context.provider.ts`
 * (Phase B.7).
 */
export interface TenantContextProvider {
  getTenantId(): string | null | undefined;
  isSuperAdmin?(): boolean;
}

let providerSingleton: TenantContextProvider | null = null;

/**
 * Register (or clear) the global tenant-context provider that
 * `createExtendedPrismaClient` consults on every query.
 *
 * Pass `null` to unregister (used in test teardown and on graceful
 * shutdown so the extension goes back to "no provider = pass-through"
 * behaviour required by seed scripts and one-shot CLI tools).
 */
export function setTenantContextProvider(provider: TenantContextProvider | null): void {
  providerSingleton = provider;
}

/**
 * Internal lookup used by the composed extension in `client.ts`.
 * Falls back to a permissive "no provider = pass-through" stance so
 * seed scripts, migrations and CLI tools that import the singleton
 * before NestJS wiring runs do not blow up.
 */
export function resolveTenantContext(): {
  tenantId: string | null | undefined;
  isSuperAdmin: boolean;
} {
  if (!providerSingleton) {
    return { tenantId: undefined, isSuperAdmin: true };
  }
  return {
    tenantId: providerSingleton.getTenantId(),
    isSuperAdmin: providerSingleton.isSuperAdmin?.() ?? false,
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

interface ApplyTenantScopeOptions {
  getTenantId: () => string | null | undefined;
  isSuperAdmin?: () => boolean;
}

interface QueryParams {
  model: string;
  args: Record<string, unknown>;
  query: (a: unknown) => Promise<unknown>;
}

/**
 * Apply the tenant-scope `$extends` to any PrismaClient (raw or already
 * extended). Use options.getTenantId / isSuperAdmin to wire the lookup
 * directly; `client.ts` passes a delegating closure that reads from
 * `resolveTenantContext()` so a single singleton provider drives every
 * extended client in the process.
 */
export function applyTenantScopeExtension(prisma: PrismaClient, options: ApplyTenantScopeOptions) {
  const ctx = () => {
    const tenantId = options.getTenantId();
    const isSuperAdmin = options.isSuperAdmin?.() ?? false;
    return { tenantId, isSuperAdmin };
  };

  // Read ops merge into args.where (or seed it). Build a per-op handler
  // that records the right op label in the thrown error message.
  const makeReadHandler = (op: string) => async (params: QueryParams) => {
    if (!isTenantScopedModel(params.model)) {
      return params.query(params.args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return params.query(params.args);
      throw new Error(`TenantScope: tenant context required for model ${params.model} operation ${op}`);
    }
    // SYSTEM-tenant read inheritance: shared catalog models resolve rows
    // owned by the caller OR the SYSTEM tenant. Writes are NOT widened.
    if (isSystemSharedReadModel(params.model)) {
      mergeSharedReadTenantIntoWhere(params.args, tenantId, params.model, op);
    } else {
      mergeTenantIntoWhere(params.args, tenantId, params.model, op);
    }
    return params.query(params.args);
  };

  // create / upsert mutate args.data (and where for upsert)
  const createHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(`TenantScope: tenant context required for model ${model} operation create`);
    }
    enforceTenantInData(args, 'data', tenantId, model, 'create');
    return query(args);
  };

  const createManyHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(`TenantScope: tenant context required for model ${model} operation createMany`);
    }
    const data = args.data;
    if (Array.isArray(data)) {
      args.data = data.map((row, index) => applyTenantToRecord(row as Record<string, unknown>, tenantId, model, `createMany[${index}]`));
    } else if (data && typeof data === 'object') {
      args.data = applyTenantToRecord(data as Record<string, unknown>, tenantId, model, 'createMany');
    }
    return query(args);
  };

  const upsertHandler = async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(`TenantScope: tenant context required for model ${model} operation upsert`);
    }
    mergeTenantIntoWhere(args, tenantId, model, 'upsert');
    enforceTenantInData(args, 'create', tenantId, model, 'upsert.create');
    return query(args);
  };

  // update / updateMany / delete / deleteMany merge tenantId into where.
  const mutateWhereHandler =
    (op: string) =>
    async ({ model, args, query }: QueryParams) => {
      if (!isTenantScopedModel(model)) {
        return query(args);
      }
      const { tenantId, isSuperAdmin } = ctx();
      if (tenantId === null || tenantId === undefined) {
        if (isSuperAdmin) return query(args);
        throw new Error(`TenantScope: tenant context required for model ${model} operation ${op}`);
      }
      mergeTenantIntoWhere(args, tenantId, model, op);
      return query(args);
    };

  // The Prisma 7 typing for `query.$allModels` is the intersection of
  // operations across every model. Because the schema enables the
  // `views` preview feature, view-backed models don't expose
  // `create` / `createMany` / `createManyAndReturn`, so those keys
  // disappear from the intersection's typed surface. The runtime
  // contract still accepts them on regular models — Prisma dispatches
  // by operation string at call time — so we cast the handler bag to
  // bypass the type-level exclusion.
  const handlers = {
    // Read
    findFirst: makeReadHandler('findFirst'),
    findFirstOrThrow: makeReadHandler('findFirstOrThrow'),
    findUnique: makeReadHandler('findUnique'),
    findUniqueOrThrow: makeReadHandler('findUniqueOrThrow'),
    findMany: makeReadHandler('findMany'),
    count: makeReadHandler('count'),
    aggregate: makeReadHandler('aggregate'),
    groupBy: makeReadHandler('groupBy'),
    // Write
    create: createHandler,
    createMany: createManyHandler,
    upsert: upsertHandler,
    update: mutateWhereHandler('update'),
    updateMany: mutateWhereHandler('updateMany'),
    delete: mutateWhereHandler('delete'),
    deleteMany: mutateWhereHandler('deleteMany'),
  };

  return prisma.$extends({
    name: 'tenantScopeFilter',
    query: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the note above the `handlers` bag: no expressible type covers the view-model exclusion.
      $allModels: handlers as any,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (kept module-private; surface is the factory above)
// ---------------------------------------------------------------------------

function mergeTenantIntoWhere(args: Record<string, unknown>, tenantId: string, model: string, op: string): void {
  const where = (args.where ?? {}) as Record<string, unknown>;
  if ('tenantId' in where && where.tenantId !== undefined) {
    if (where.tenantId !== tenantId) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(where.tenantId)} but context is ${JSON.stringify(tenantId)}`,
      );
    }
    args.where = where;
    return;
  }
  args.where = { ...where, tenantId };
}

/**
 * A pinned `tenantId` on a SYSTEM-shared read is admissible when it names the caller, SYSTEM,
 * or — as `{ in: [...] }` — any subset of that pair. The `in` form is exactly the widening this
 * extension applies itself; repositories that read the two-tier cascade explicitly
 * (`AiRoutingPolicyRepository.findCandidates`, TASK-862) pass it and must not be refused.
 */
function isWithinSharedReadPair(pinned: unknown, tenantId: string): boolean {
  if (pinned === tenantId || pinned === SYSTEM_TENANT_ID) return true;
  if (pinned && typeof pinned === 'object' && Array.isArray((pinned as { in?: unknown }).in)) {
    const ids = (pinned as { in: unknown[] }).in;
    return ids.length > 0 && ids.every((id) => id === tenantId || id === SYSTEM_TENANT_ID);
  }
  return false;
}

/**
 * Read-path tenant merge for SYSTEM-shared catalog models: widen the filter to
 * `tenantId IN [caller, SYSTEM]` so the caller resolves both its own rows and
 * the shared platform catalog. A caller may still pin an explicit `tenantId`,
 * but only to the caller's own tenant or SYSTEM — any other value is the same
 * cross-tenant violation `mergeTenantIntoWhere` rejects.
 */
function mergeSharedReadTenantIntoWhere(args: Record<string, unknown>, tenantId: string, model: string, op: string): void {
  const where = (args.where ?? {}) as Record<string, unknown>;
  if ('tenantId' in where && where.tenantId !== undefined) {
    if (!isWithinSharedReadPair(where.tenantId, tenantId)) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(where.tenantId)} but context is ${JSON.stringify(tenantId)} (SYSTEM inheritance allows only [caller, SYSTEM])`,
      );
    }
    args.where = where;
    return;
  }
  args.where = { ...where, tenantId: { in: [tenantId, SYSTEM_TENANT_ID] } };
}

function enforceTenantInData(args: Record<string, unknown>, field: 'data' | 'create', tenantId: string, model: string, op: string): void {
  const payload = args[field];
  if (!payload || typeof payload !== 'object') {
    // Nothing to inject into — leave it for Prisma to reject.
    return;
  }
  args[field] = applyTenantToRecord(payload as Record<string, unknown>, tenantId, model, op);
}

function applyTenantToRecord(record: Record<string, unknown>, tenantId: string, model: string, op: string): Record<string, unknown> {
  if ('tenantId' in record && record.tenantId !== undefined && record.tenantId !== null) {
    if (record.tenantId !== tenantId) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(record.tenantId)} but context is ${JSON.stringify(tenantId)}`,
      );
    }
    return record;
  }
  return { ...record, tenantId };
}
