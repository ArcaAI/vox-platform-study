/**
 * Tenant-Scope Prisma `$extends` Extension — TASK-305 Phase B.
 *
 * This extension injects `tenantId` from a caller-supplied context
 * provider into every read/write against a tenant-scoped model. It is
 * the second line of defence behind the database-level Row-Level
 * Security policies that ship in Phase C; together they form the
 * "defence in depth" multi-tenancy posture mandated by the audit
 * (`docs/multi-tenancy-audit/02-prisma-schema-review.md` §B7).
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
 *     handled by Phase D guards.
 *   - `SET LOCAL app.tenant_id` for RLS — owned by Phase C.
 *
 * @see docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md
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
 * identity (audit §B6 / TASK-305 Phase F). A user's membership in a tenant
 * is modeled by the two tenant-scoped JOIN tables — `UserRoleAssignment`
 * (role) and `UserDepartment` (department) — both of which ARE in this list.
 * `UserVoiceProfile` is the TASK-490 exception: it is biometric PHI, so each
 * profile is stamped with its enrollment tenant and scoped like any other
 * PHI-bearing model (a user working in multiple tenants enrolls per tenant).
 *
 * History: an earlier revision predicted Phase A would add `tenantId` to
 * the `User*` tables and that this list would grow with them. That never
 * happened and was the wrong call (see TASK-305 Phase F). `UserDepartment`
 * was added to this list by Phase F (2026-06-02) so its reads/writes are
 * tenant-injected like every other tenant-scoped model.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  // consultation.prisma (7)
  'Consultation',
  'ContextItem',
  'ContextItemVersion',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
  'Highlight', // doctor-authored highlight (TASK-344); scoped by TASK-349
  // audit.prisma (1)
  'AuditLog',
  // webhook.prisma (1)
  'Webhook',
  // notification.prisma (2)
  'Notification',
  'ResourceSubscription',
  // tag.prisma (1)
  'Tag',
  // apikey.prisma (1)
  'ApiKey',
  // globalSetting.prisma (1)
  'GlobalSetting',
  // stt.prisma (4)
  'AsrPipeline',
  'AsrPipelineVersion', // version-history child of AsrPipeline (doc-08 F3)
  'AiModel',
  'TranscriptionJob',
  // department.prisma (1)
  'Department',
  // user.prisma (3)
  'UserRoleAssignment',
  'UserDepartment',
  // TASK-490 — biometric voice profile, stamped with the enrollment tenant so
  // reads/writes are tenant-scoped like every other PHI-bearing model (the
  // STT-v2 preseed path applies the same filter in raw SQL).
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
  'TenantFrontendConfig', // per-tenant frontend pipeline config (doc-08 F2)
  // media.prisma (1)
  'Media',
  // harness.prisma (7) — TASK-330 Phase 0/6 clinical-documentation harness
  'GoldenSet',
  'GoldenCase',
  'EvalRun',
  'EvalScore',
  'HarnessAuditEvent', // append-only WORM audit (no soft-delete; see client.ts)
  // TASK-330 Phase 6 — Harness Administration Console: editable runtime policy.
  'HarnessPolicy', // also a SYSTEM-shared read model (global-default row, below)
  'HarnessPolicyChange', // append-only WORM change log (no soft-delete)
  // knowledge.prisma (2) — TASK-330 Phase 3 institutional RAG corpus
  'KnowledgeDocument',
  'KnowledgeChunk',
  // pipeline-policy.prisma (2) — TASK-356 Phase 5 realtime-cascade policy.
  'PipelinePolicy', // also a SYSTEM-shared read model (global-default row, below)
  'PipelinePolicyChange', // append-only WORM change log (no soft-delete)
  // tenant-tts-config.prisma (2) — TASK-496 per-tenant TTS config + BYO creds.
  'TenantTtsConfig', // also a SYSTEM-shared read model (platform-default row, below)
  'TenantTtsProviderCredential', // per-(tenant,provider) BYO key; NOT SYSTEM-shared
  // ai-task-default.prisma (1) — TASK-506 per-tenant default model per AI task.
  'AiTaskDefault', // also a SYSTEM-shared read model (platform-default row, below)
  // ai-provider-connection.prisma (1) — TASK-524 config-plane core. WHERE a
  // serving provider lives + HOW to authenticate. SYSTEM row = platform
  // default; tenant rows are BYO cloud credentials (azure/bedrock only,
  // service-enforced). Secret-bearing (`encryptedApiKey`), and unlike
  // TenantTtsProviderCredential it IS SYSTEM-shared for reads — see the
  // justification on the SYSTEM_SHARED_READ_MODELS entry below.
  'AiProviderConnection',
  // ai-runtime-profile.prisma (1) — TASK-524 config-plane core. Hyperparameter /
  // context / concurrency profiles per (provider, modelSlug). SYSTEM-only rows
  // in this program (global-admin-only per owner expectation E5); tenantId is
  // carried for the house template + forward compatibility.
  'AiRuntimeProfile', // also a SYSTEM-shared read model (platform-default row, below)
  // entitlement.prisma (1) — TASK-392 rolling-monthly usage meters. The
  // reconcile job reads/writes these via the UNSCOPED `baseClient` (explicit
  // tenantId filters, no CLS — same escape hatch as the audit-retention
  // purge), so scoping here is behaviour-neutral for it while protecting any
  // future extended-client/repository access. `TenantEntitlement` is NOT
  // here — see INTENTIONALLY_UNSCOPED in the drift-guard test (pre-auth
  // throttler + global-admin cross-tenant override CRUD read it through the
  // extended client without a matching CLS tenant).
  'TenantUsageMeter',
  // identity-provider.prisma (3) — TASK-498 tenant-scoped external OIDC IdP.
  // None are SYSTEM-shared reads — a tenant's IdP config/links/domains are
  // never visible cross-tenant.
  'TenantIdentityProvider',
  'FederatedIdentity',
  'TenantIdentityProviderDomain',
  // agent-trajectory.prisma (1) — Phase 2A ordered session trajectory.
  // Tenant-scoped ops telemetry (per-session step stream). NOT SYSTEM-shared —
  // a tenant's trajectory is never visible cross-tenant. It is soft-delete
  // EXEMPT (retention-pruned, no resourceStatus column) — see
  // MODELS_WITHOUT_SOFT_DELETE in client.ts.
  'AgentTrajectoryStep',
  // mcp-server.prisma — external-tools registry. A STANDARD tenant-
  // scoped config model (tenantId + resourceStatus soft-delete + _version OCC +
  // audit). SYSTEM-tenant rows are the shared registry every tenant's harness
  // run READS to resolve a server (also a SYSTEM-shared read model below);
  // WRITES stay SYSTEM-only (global-admin, service layer).
  'McpServer',
  // consultation.prisma — segment-level transcript structure. A
  // per-transcript annotation table (like NamedEntity / AudioRecording),
  // tenant-scoped and soft-delete EXEMPT (no resourceStatus column; segments
  // live/die with their parent transcript) — see MODELS_WITHOUT_SOFT_DELETE.
  'TranscriptSegment',
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
  // TASK-330 Phase 6 — the harness GLOBAL-DEFAULT policy row is owned by the
  // SYSTEM tenant and every tenant must read it to compute its effective policy
  // (tenant row merged over the system default). A READ therefore widens to
  // `tenantId IN [caller, SYSTEM]`; WRITES are NOT widened, so a tenant can read
  // but never mutate the SYSTEM-owned global default (only a platform admin can,
  // through the dedicated global-default service path).
  'HarnessPolicy',
  // TASK-356 Phase 5 — the realtime-cascade GLOBAL-DEFAULT policy row is owned
  // by the SYSTEM tenant and read by every tenant's ConfigResolver cascade
  // (doctor→department→tenant→SYSTEM default). READS widen to [caller, SYSTEM];
  // WRITES are NOT widened (only a platform admin mutates the SYSTEM default).
  'PipelinePolicy',
  // TASK-496 — the per-tenant TTS PLATFORM-DEFAULT row is owned by the SYSTEM
  // tenant and read by every tenant's resolveForTenant (tenant row merged over
  // the SYSTEM default). READS widen to [caller, SYSTEM]; WRITES are NOT widened
  // (only a platform admin mutates the SYSTEM default). Credentials are NEVER
  // shared — TenantTtsProviderCredential is intentionally absent here.
  'TenantTtsConfig',
  // TASK-506 — per-task default-model rows (guardrail.validate / nlp.*): the
  // SYSTEM tenant row is the platform default every tenant merges under its
  // own row (AiTaskDefaultService.getEffective). READS widen to
  // [caller, SYSTEM]; WRITES are NOT widened (guardrail.* keys are additionally
  // global-admin-only at the service layer).
  'AiTaskDefault',
  // TASK-524 — the provider CONNECTION catalog: the SYSTEM row records where a
  // serving provider lives and (as Vault-Transit ciphertext) how to auth to it.
  // Every tenant's `resolveConnection` cascade (tenant row → SYSTEM row → env)
  // runs under tenant CLS at request time and would otherwise read nothing.
  // READS widen to [caller, SYSTEM]; WRITES are NOT widened.
  //
  // CAVEAT — this is the first SECRET-BEARING model in this list. It is safe
  // because the widening is [caller, SYSTEM] only (never another tenant's BYO
  // row), the `encryptedApiKey` ciphertext is inert without gateway-side
  // Vault-Transit decrypt, and NO read DTO ever carries it (`hasKey` boolean
  // only). Contrast TenantTtsProviderCredential, which is deliberately absent
  // above: that model has no SYSTEM row at all, so sharing would buy nothing.
  'AiProviderConnection',
  // TASK-524 — hyperparameter/context/concurrency profiles. SYSTEM-only rows,
  // read by every tenant's injection cascade at request time. No secrets on
  // the model at all. READS widen to [caller, SYSTEM]; WRITES are NOT widened.
  'AiRuntimeProfile',
  // the MCP external-tools registry: server rows are registered by a
  // global admin under the SYSTEM tenant and every tenant's harness run must
  // READ the shared registry to resolve a server it references (server metadata
  // only — `authRef` is a Vault PATH, never secret material). READS widen to
  // [caller, SYSTEM]; WRITES are NOT widened (registry mutation is global-admin
  // only at the service layer, the guardrail.* precedent).
  'McpServer',
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
]);

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
 * the GLOBAL_ADMIN role (cross-tenant audit / platform-admin paths).
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
export function setTenantContextProvider(
  provider: TenantContextProvider | null,
): void {
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
export function applyTenantScopeExtension(
  prisma: PrismaClient,
  options: ApplyTenantScopeOptions,
) {
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
      throw new Error(
        `TenantScope: tenant context required for model ${params.model} operation ${op}`,
      );
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
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation create`,
      );
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
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation createMany`,
      );
    }
    const data = args.data;
    if (Array.isArray(data)) {
      args.data = data.map((row, index) =>
        applyTenantToRecord(row as Record<string, unknown>, tenantId, model, `createMany[${index}]`),
      );
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
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation upsert`,
      );
    }
    mergeTenantIntoWhere(args, tenantId, model, 'upsert');
    enforceTenantInData(args, 'create', tenantId, model, 'upsert.create');
    return query(args);
  };

  // update / updateMany / delete / deleteMany merge tenantId into where.
  const mutateWhereHandler = (op: string) => async ({ model, args, query }: QueryParams) => {
    if (!isTenantScopedModel(model)) {
      return query(args);
    }
    const { tenantId, isSuperAdmin } = ctx();
    if (tenantId === null || tenantId === undefined) {
      if (isSuperAdmin) return query(args);
      throw new Error(
        `TenantScope: tenant context required for model ${model} operation ${op}`,
      );
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
  // bypass the type-level exclusion. This pattern matches the soft-
  // delete extension's `({ model, args, query }: any)` cast style.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $allModels: handlers as any,
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (kept module-private; surface is the factory above)
// ---------------------------------------------------------------------------

function mergeTenantIntoWhere(
  args: Record<string, unknown>,
  tenantId: string,
  model: string,
  op: string,
): void {
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
 * Read-path tenant merge for SYSTEM-shared catalog models: widen the filter to
 * `tenantId IN [caller, SYSTEM]` so the caller resolves both its own rows and
 * the shared platform catalog. A caller may still pin an explicit `tenantId`,
 * but only to the caller's own tenant or SYSTEM — any other value is the same
 * cross-tenant violation `mergeTenantIntoWhere` rejects.
 */
function mergeSharedReadTenantIntoWhere(
  args: Record<string, unknown>,
  tenantId: string,
  model: string,
  op: string,
): void {
  const where = (args.where ?? {}) as Record<string, unknown>;
  if ('tenantId' in where && where.tenantId !== undefined) {
    if (where.tenantId !== tenantId && where.tenantId !== SYSTEM_TENANT_ID) {
      throw new Error(
        `TenantScope: tenantId mismatch on ${model}.${op} — caller passed ${JSON.stringify(where.tenantId)} but context is ${JSON.stringify(tenantId)} (SYSTEM inheritance allows only [caller, SYSTEM])`,
      );
    }
    args.where = where;
    return;
  }
  args.where = { ...where, tenantId: { in: [tenantId, SYSTEM_TENANT_ID] } };
}

function enforceTenantInData(
  args: Record<string, unknown>,
  field: 'data' | 'create',
  tenantId: string,
  model: string,
  op: string,
): void {
  const payload = args[field];
  if (!payload || typeof payload !== 'object') {
    // Nothing to inject into — leave it for Prisma to reject.
    return;
  }
  args[field] = applyTenantToRecord(payload as Record<string, unknown>, tenantId, model, op);
}

function applyTenantToRecord(
  record: Record<string, unknown>,
  tenantId: string,
  model: string,
  op: string,
): Record<string, unknown> {
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
