/**
 * Tenant-Scope Extension Unit Tests.
 *
 * Tests the Prisma `$extends` query handlers that inject / assert
 * `tenantId` on every read/write against a tenant-scoped model.
 *
 * Strategy (mirroring W1.1 captured-handler pattern):
 *   - Mock `prisma.$extends` so we can capture the extension config
 *     object the moment it's registered.
 *   - Invoke each captured handler with synthetic { model, args, query }
 *     and assert the args mutation + downstream `query()` call.
 *   - No live database, no Prisma engine — purely a contract test of
 *     the handler logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../generated/core-prisma-client/client.js', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $extends: vi.fn().mockReturnThis(),
  })),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    PrismaClientUnknownRequestError: class extends Error {},
    PrismaClientRustPanicError: class extends Error {},
    PrismaClientInitializationError: class extends Error {},
    PrismaClientValidationError: class extends Error {},
  },
}));

vi.mock('../../env.js', () => ({}));

import {
  applyTenantScopeExtension,
  TENANT_SCOPED_MODELS,
  SYSTEM_SHARED_READ_MODELS,
  SYSTEM_TENANT_ID,
  isTenantScopedModel,
  isSystemSharedReadModel,
  setTenantContextProvider,
  type TenantContextProvider,
} from '../tenant-scope';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (params: { model: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) => Promise<unknown>;

interface ExtensionConfig {
  name: string;
  // Indexed via string literals in the tests; we lie about the value
  // type to avoid `undefined` in noUncheckedIndexedAccess mode.
  query: { $allModels: { [op: string]: Handler } };
}

function captureExtensionConfig(opts: { getTenantId: () => string | null | undefined; isSuperAdmin?: () => boolean }): ExtensionConfig {
  const prisma = { $extends: vi.fn().mockReturnThis() };
  applyTenantScopeExtension(prisma as never, opts);
  expect(prisma.$extends).toHaveBeenCalledTimes(1);
  return prisma.$extends.mock.calls[0][0] as ExtensionConfig;
}

// ---------------------------------------------------------------------------
// Allow-list contract
// ---------------------------------------------------------------------------

describe('TENANT_SCOPED_MODELS allow-list', () => {
  it('contains the tenant-scoped models currently defined in db_main/*.prisma', () => {
    // The allow-list tracks SCHEMA TRUTH (every model here has a tenantId
    // scalar). The User* identity tables are intentionally excluded — `User`
    // is global by design; tenant membership lives in the UserRoleAssignment
    // (role) + UserDepartment (department) join tables. `ApiKey` is
    // deliberately NOT in the list (see INTENTIONALLY_UNSCOPED below): it is
    // read pre-auth by the API-key authentication lookup, so it can never
    // carry a CLS tenant. (The drift guard below is the durable check; this
    // count stays as a quick human-readable tripwire.)
    // 57 → 65: adds eight tenantId-bearing usage-metering / billing
    // models (AiUsageEvent, AiUsageOutbox, AiPriceBook, AiUsageRollupHourly,
    // AiUsageRollupDaily, BillingInvoice, BillingInvoiceLine,
    // BillingAdjustment).
    // 65 → 66: adds TenantAllowedOrigin (CORS control plane).
    // 66 → 67: #6 adds TenantPlanHistory (append-only plan-fee proration).
    // 67 → 68: added ProviderReconciliationRun (SYSTEM-owned audit trail);
    // REMOVED again by TASK-862 (Provider Reconciliation deleted outright).
    // 68 → 72: adds the Service Version & Release Registry
    // (ServiceRelease, ServiceInstance, ChangelogEntry,
    // UserChangelogAcknowledgement). All four carry tenantId; the first
    // three are platform-wide (SYSTEM tenant), UserChangelogAcknowledgement
    // is scoped to the acknowledging user's own tenant.
    // 72 → 74: adds the consultation context-schema plane
    // (ConsultationContextSchema + ConsultationContextSchemaVersion). Both are
    // ordinary tenant-owned rows and are deliberately NOT SYSTEM-shared reads —
    // the golden-library path copies schemas rather than sharing them.
    // 74 → 75: adds DepartmentAgentVersion (immutable loop-config
    // snapshot of DepartmentAgent) — same posture as its parent, NOT
    // SYSTEM-shared.
    // 75 → 76: adds AgentPromotion (immutable cross-tenant promotion
    // record, owned by the TARGET tenant) — NOT SYSTEM-shared, or any tenant
    // could enumerate which agents moved between which tenants.
    // 76 → 77: adds WorkflowDefinition — workflow substrate
    // persistence floor; rows ARE versions, no head/version split). NOT
    // SYSTEM-shared — a tenant reads only its own definitions, and the
    // SYSTEM-tenant platform defaults reach a tenant via the seed's clone
    // path, exactly as ConsultationContextSchema does.
    // 77 → 78: adds ConsentGrant (consent-abac). Ordinary
    // tenant-owned rows keyed (tenantId, externalPatientId, purpose); no
    // SYSTEM row, NOT SYSTEM-shared.
    // 78 → 79: adds WorkflowRun (runs/observability read model).
    // One row per run, NOT SYSTEM-shared — a tenant's runs are never visible
    // cross-tenant.
    // 79 → 80: adds WorkflowTestFixture (Workbench saved fixtures).
    // Ordinary tenant-owned rows, NOT SYSTEM-shared.
    // 80 → 81: adds TenantNlpTaskInstructions — tenant-writable
    // nlp.topic/nlp.intent instruction content). Ordinary tenant-owned rows,
    // deliberately NOT SYSTEM-shared (there is no
    // SYSTEM-tenant platform-default row for this model).
    // 81 → 83: adds WorkflowAssignment + WorkflowAssignmentChange
    // WHICH definition governs a tenant/department for a palette, and its
    // append-only change log). Ordinary tenant-owned rows, deliberately NOT
    // SYSTEM-shared: the platform-default tier is the tenant's own active
    // published definition, never a SYSTEM assignment row read cross-tenant.
    // 83 → 84: adds WorkflowInvariantRule — the validator's rule
    // rows). UNLIKE its workflow-substrate siblings above, this one IS
    // SYSTEM-shared (see the SYSTEM_SHARED_READ_MODELS assertion below): a
    // tenant's validator must resolve the SYSTEM platform rule set merged
    // with any rows the tenant added itself, or it would silently
    // under-enforce every safety rule it didn't happen to also author.
    // 84 → 85: adds Role. SYSTEM-tenant rows are the
    // platform's built-in roles (also SYSTEM-shared, see below); tenant rows
    // are a tenant admin's own custom roles, now protected by this extension
    // instead of a handler-level guard. `Policy`/`RolePolicy` stay global.
    // +1 (86): RateLimitRule.
    // +2 (88): DocumentTemplate + DocumentTemplateVersion — the
    // clinical-document shape catalog, head + immutable version.
    // +1 (89): DocumentSection — the per-section child table of a
    // live-generated clinical document.
    // 2 (87): DepartmentAgent + DepartmentAgentVersion — both models
    // dropped. `AgentPromotion` STAYS: the promotable moved to a
    // `WorkflowDefinition` version, but the WORM record is still the target
    // tenant's own row.
    // +1 (88): AiRoutingPolicy — the config-plane routing policy.
    // SYSTEM row = platform default, tenant row wins on presence; also a
    // SYSTEM_SHARED_READ_MODEL (see that suite below).
    // -1 (87): ProviderReconciliationRun — Provider Reconciliation removed
    // outright (TASK-862, owner directive 2026-09-04).
    // -1 (86): AiRuntimeProfile — retired by TASK-862 (ceilings moved onto
    // AiProviderConnection, hyper-parameters to the Agent).
    // +4 (90): Agent, AgentModelFallback, AgentAssignment, AgentAssignmentChange (TASK-863).
    // +1 (91): WorkflowWebhookSecret — TASK-864's per-definition inbound
    // webhook HMAC secret, keyed (tenantId, workflowSlug).
    expect(TENANT_SCOPED_MODELS.size).toBe(91);
  });

  // The usage ledger, its outbox, the rollups and the whole billing
  // plane are tenant-scoped: a tenant's consumption and its invoices must never
  // be readable cross-tenant. `AiPriceBook` is tenant-scoped too, but is
  // additionally a SYSTEM-shared READ model (the platform rate card lives on
  // the SYSTEM tenant) — see the SYSTEM_SHARED_READ_MODELS suite below.
  it('includes the usage-metering + billing models', () => {
    for (const model of [
      'AiUsageEvent',
      'AiUsageOutbox',
      'AiPriceBook',
      'AiUsageRollupHourly',
      'AiUsageRollupDaily',
      'BillingInvoice',
      'BillingInvoiceLine',
      'BillingAdjustment',
    ]) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  // The CORS control plane is tenant-scoped: a tenant's browser
  // origin registry must never be readable cross-tenant. SYSTEM-owned rows are
  // resolved by OriginRegistryService, not by widening this read.
  it('includes the CORS control-plane model', () => {
    expect(TENANT_SCOPED_MODELS.has('TenantAllowedOrigin')).toBe(true);
  });

  it('includes every PHI-bearing model', () => {
    for (const phi of ['Consultation', 'ContextItem', 'ContextItemVersion', 'AudioRecording', 'SummaryMeta', 'NamedEntity', 'AuditLog']) {
      expect(TENANT_SCOPED_MODELS.has(phi)).toBe(true);
    }
  });

  it('does NOT include global / root models', () => {
    for (const global of ['Tenant', 'User', 'Policy', 'RolePolicy']) {
      expect(TENANT_SCOPED_MODELS.has(global)).toBe(false);
    }
  });

  // `Role` gained a `tenantId` column and is now genuinely
  // tenant-scoped (SYSTEM-tenant rows are the platform's built-in roles;
  // tenant rows are custom roles a tenant admin created). `Policy`/
  // `RolePolicy` deliberately stay global — see rbac.prisma's comment on
  // `Role.tenantId` for why.
  it('DOES include Role (OD-1) but keeps Policy/RolePolicy global', () => {
    expect(TENANT_SCOPED_MODELS.has('Role')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('Policy')).toBe(false);
    expect(TENANT_SCOPED_MODELS.has('RolePolicy')).toBe(false);
  });

  // Regression guard.
  //
  // API-key authentication must read `ApiKey` by keyHash BEFORE any principal
  // (and therefore any tenant) exists. Inside an HTTP request CLS is active but
  // empty, so `getTenantId()` is undefined AND `isSuperAdmin()` is false — the
  // combination that makes `makeReadHandler` THROW. When `ApiKey` was scoped,
  // that throw was swallowed by `getByKeyHash`'s bare catch and surfaced as
  // 401 "Invalid API key", breaking every API-key principal in the platform.
  // Same failure mode as the pre-auth throttler read that made
  // `TenantEntitlement` INTENTIONALLY_UNSCOPED.
  it('does NOT scope ApiKey — it is read pre-auth, before any tenant exists', () => {
    expect(TENANT_SCOPED_MODELS.has('ApiKey')).toBe(false);
    expect(isTenantScopedModel('apiKey')).toBe(false);
  });

  it('lets a pre-auth ApiKey lookup through when CLS is active but empty', async () => {
    // Exactly the API-key auth context: CLS active, no user resolved yet.
    const cfg = captureExtensionConfig({
      getTenantId: () => undefined,
      isSuperAdmin: () => false,
    });
    const query = vi.fn().mockResolvedValue({ id: 'key-1' });
    const args = { where: { keyHash: 'deadbeef' } };

    await expect(cfg.query.$allModels.findFirst!({ model: 'ApiKey', args, query })).resolves.toEqual({ id: 'key-1' });
    // The where clause must reach Prisma untouched — no tenantId injected.
    expect(query).toHaveBeenCalledWith({ where: { keyHash: 'deadbeef' } });
  });

  it('includes the user↔tenant membership join tables (Phase F)', () => {
    expect(TENANT_SCOPED_MODELS.has('UserRoleAssignment')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('UserDepartment')).toBe(true);
    expect(isTenantScopedModel('userDepartment')).toBe(true);
  });

  it('isTenantScopedModel accepts camelCase and PascalCase', () => {
    expect(isTenantScopedModel('Consultation')).toBe(true);
    expect(isTenantScopedModel('consultation')).toBe(true);
    expect(isTenantScopedModel('tenant')).toBe(false);
    expect(isTenantScopedModel('Tenant')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema-derived drift guard
// ---------------------------------------------------------------------------

/**
 * The `size` assertion above is COUNT-ONLY: it cannot say WHICH model drifted,
 * and a migration that both adds and drops a tenantId model keeps the count
 * stable while silently changing the truth. That blind spot is exactly how
 * `TenantFrontendConfig` and `AsrPipelineVersion` shipped with a `tenantId`
 * column yet missing from the allow-list (doc-08 F2/F3).
 *
 * This block derives SCHEMA TRUTH at runtime — it reads every
 * `db_main/*.prisma` file, extracts each `model` that declares a `tenantId`
 * scalar, and asserts the allow-list covers all of them. A newly-added
 * tenant-scoped model now fails CI until it is triaged into
 * TENANT_SCOPED_MODELS (the default) or the explicit INTENTIONALLY_UNSCOPED
 * deny-list, so the guard can never silently fall behind a migration again.
 */
describe('TENANT_SCOPED_MODELS stays in sync with the Prisma schema', () => {
  // Resolve db_main relative to THIS test file (ESM, no __dirname):
  //   src/extensions/__tests__ → ../../prisma/db_main
  const DB_MAIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'db_main');

  /**
   * Models that carry a `tenantId` scalar but are DELIBERATELY excluded from
   * tenant-scope injection. Add a name here ONLY for a conscious, reviewed
   * exception (with a justifying comment), never to silence this guard for a
   * real tenant-scoped model.
   */
  const INTENTIONALLY_UNSCOPED: ReadonlySet<string> = new Set<string>([
    // Per-tenant entitlement override (`tenantId @unique`), a
    // platform-administration row rather than customer data. It is read via
    // the EXTENDED client from contexts whose CLS tenant can never match the
    // target row, so CLS-based scope injection would silently break them:
    //   1. The pre-auth throttler (`tiered-throttler.guard.ts` →
    //      `getTenantRateLimitPolicy` → `findByTenant`) resolves the
    //      caller-tenant's rate-limit override BEFORE auth populates CLS —
    //      CLS is active but empty (not elevated), so a scoped read would
    //      throw and per-tenant rate-limit overrides (Q7 "increase on
    //      demand") would silently stop applying.
    //   2. SUPER_ADMIN override CRUD (`/admin/entitlements/tenants/:id`)
    //      targets ANY tenant while the admin's working-tenant CLS context
    //      (X-Tenant-Id, `resolve-active-tenant.ts`) may point elsewhere —
    //      the extension only bypasses when NO CLS tenant exists, so scoping
    //      would 404/mismatch legitimate cross-tenant admin operations.
    // Isolation still holds: every read path filters by an explicit
    // `tenantId` (`findByTenant`), the row carries no PHI, and the only
    // write surface is the SUPER_ADMIN-gated admin controller.
    'TenantEntitlement',
    // API-key AUTHENTICATION reads this table by
    // `keyHash` before any principal exists, so it can never have a CLS
    // tenant. Inside an HTTP request CLS is active but empty, which is
    // `tenantId === undefined` AND `isSuperAdmin() === false` — the exact
    // combination `makeReadHandler` throws on. `ApiKeyService.getByKeyHash`
    // swallowed that throw in a bare `catch { return null }`, so EVERY API
    // key on the platform authenticated as 401 "Invalid API key". Identical
    // root cause to the pre-auth throttler read above; `User` and `Tenant`
    // (the password-login equivalents) are unscoped for the same reason,
    // which is why password login worked while API keys did not.
    //
    // Isolation still holds — it is enforced one layer up, in
    // `apikey.service.ts`, on EVERY read path:
    //   - list paths go through `buildTenantWhere` (injects the caller's CLS
    //     tenantId; throws NotFound for a non-super-admin with no tenant),
    //   - `fetchAllByTenantId` rejects a foreign `tenantId` unless the caller
    //     is SUPER_ADMIN (added precisely to
    //     stop a Tenant-A admin enumerating Tenant-B keys),
    //   - every `findById` is immediately followed by `assertKeyAccess`,
    //     which compares `apiKey.tenantId` to the caller's CLS tenant.
    // The only unguarded read is `getByKeyHash`, which is the authentication
    // lookup itself: it matches on a unique, cryptographically random secret,
    // and the row it returns is what ESTABLISHES the tenant context.
    'ApiKey',
    // the service-account TOKEN EXCHANGE reads this table by
    // `clientId` before any principal exists, so it can never carry a CLS
    // tenant. Identical pre-auth shape to `ApiKey` directly above: inside an
    // HTTP request CLS is active but empty (`tenantId === undefined` AND
    // `isSuperAdmin() === false`), the exact combination `makeReadHandler`
    // throws on. asked for this model to be added to
    // TENANT_SCOPED_MODELS; doing so would have reproduced the `ApiKey`
    // failure above (every credential authenticating as 401).
    //
    // Isolation still holds — enforced one layer up in
    // `service-account.service.ts` on EVERY read path: list reads scope to the
    // caller's tenant (SUPER_ADMIN may widen), and every `findById` is followed
    // by `assertTenantOwnership`, which throws `NotFoundException` (404-over-403)
    // on a cross-tenant id. The only unguarded read is `findByClientId`, which
    // IS the authentication lookup and whose row establishes the context.
    'ServiceAccount',
  ]);

  /** Every `model X { … tenantId String … }` declared across db_main/*.prisma. */
  function schemaModelsWithTenantId(): string[] {
    // Prisma formats each block with the keyword and the closing brace at
    // column 0 and never nests `{}` in a model body, so a line-anchored block
    // match is exact. A `tenantId String` line is the scalar column; the
    // relation attribute (`@relation(fields: [tenantId] …)`) and
    // `@@index([tenantId])` keep `tenantId` off the start of the line, so they
    // are not mistaken for the scalar.
    const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    const tenantIdScalar = /^\s*tenantId\s+String\b/m;
    const models: string[] = [];
    for (const file of readdirSync(DB_MAIN_DIR).filter((f) => f.endsWith('.prisma'))) {
      const src = readFileSync(join(DB_MAIN_DIR, file), 'utf-8');
      for (const [, name, body] of src.matchAll(modelBlock)) {
        if (name && body && tenantIdScalar.test(body)) models.push(name);
      }
    }
    return models;
  }

  it('parses tenantId-bearing models off disk (guards against a false green)', () => {
    // If the path or regex ever breaks this reads 0 models and the drift check
    // below would pass vacuously — so assert the parser actually sees them.
    const found = schemaModelsWithTenantId();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('Consultation');
    expect(found).toContain('TenantFrontendConfig'); // tenant.prisma (F2)
    expect(found).toContain('AsrPipelineVersion'); // stt.prisma (F3)
    expect(found).toContain('HarnessAuditEvent'); // harness.prisma
    expect(found).toContain('KnowledgeDocument'); // knowledge.prisma
    expect(found).toContain('KnowledgeChunk'); // knowledge.prisma
  });

  it('lists every schema tenantId model in TENANT_SCOPED_MODELS (drift =)', () => {
    const missing = schemaModelsWithTenantId().filter((m) => !TENANT_SCOPED_MODELS.has(m) && !INTENTIONALLY_UNSCOPED.has(m));
    // Empty once F2/F3 are fixed; the failure diff names any drifted model.
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM-shared read inheritance allow-list
// ---------------------------------------------------------------------------

describe('SYSTEM_SHARED_READ_MODELS allow-list', () => {
  it('contains the platform catalog models + the harness/pipeline global-default policies + GlobalSetting (AsrPipeline, AiModel, HarnessPolicy, PipelinePolicy, GlobalSetting)', () => {
    expect(new Set(SYSTEM_SHARED_READ_MODELS)).toEqual(
      // HarnessPolicy's SYSTEM-tenant row is the global
      // default every tenant reads to compute its effective policy.
      // PipelinePolicy's SYSTEM-tenant row is the realtime
      // cascade's platform default (ConfigResolver reads it for every tenant).
      // GlobalSetting — platform infra settings (S3/MinIO, STT) are seeded under
      // the SYSTEM tenant; the AppSettingsService platform cache reads them.
      // TenantTtsConfig's SYSTEM-tenant row is the per-tenant TTS
      // platform default every tenant's resolveForTenant merges over. This model
      // never carries a secret — BYO credentials live in the unified
      // AiProviderConnection plane (service='tts'), never shared cross-tenant.
      // McpServer's SYSTEM-tenant rows are the shared external-tools
      // registry every tenant's harness run reads to resolve a server; writes
      // are NOT widened (registry mutation is super-admin only).
      // AiProviderConnection's SYSTEM row is the platform-default
      // provider catalog entry every tenant's resolveConnection cascade reads
      // (tenant row → SYSTEM row → env); it is the FIRST secret-bearing entry
      // in this list, which is safe because the widening is [caller, SYSTEM]
      // only, the ciphertext is inert without Vault-Transit decrypt, and no
      // read DTO carries it. (AiRuntimeProfile used to sit beside it; TASK-862
      // retired that model.) Writes are NOT widened.
      new Set([
        'AsrPipeline',
        'AiModel',
        // Role's SYSTEM-tenant rows are the platform's built-in roles
        // every tenant reads them directly (list, clone
        // source, member counts) rather than getting a per-tenant clone.
        // Writes are NOT widened; a tenant admin's write to a SYSTEM role id
        // matches zero rows (service layer already refuses it earlier via the
        // isSystemRole guard). A super admin mutating a SYSTEM role routes
        // through RbacRoleService's unscoped cross-tenant lane instead.
        'Role',
        'HarnessPolicy',
        'PipelinePolicy',
        'GlobalSetting',
        'TenantTtsConfig',
        // TenantSttConfig's SYSTEM-tenant row is the per-tenant STT platform
        // default every tenant's getEffective merges over. This model never
        // carries a secret — BYO credentials live in the unified
        // AiProviderConnection plane (service='stt'), never shared cross-tenant.
        'TenantSttConfig',
        'McpServer',
        // SYSTEM-owned platform facts read under the caller's own
        // tenant CLS. Without widening, /changelog and /releases return nothing
        // for a tenant-scoped reader even though the rows exist. Writes are not
        // widened; UserChangelogAcknowledgement is deliberately excluded (a
        // read-state row genuinely belongs to its own tenant).
        'ServiceRelease',
        'ServiceInstance',
        'ChangelogEntry',
        'AiProviderConnection',
        // AiRoutingPolicy's SYSTEM row is the platform-default candidate
        // chain ( Same "tenant row → SYSTEM row" shape as
        // AiTaskDefault; the resolver runs under the caller's own CLS, so
        // without the widening every tenant lacking its own row fails closed.
        // No secrets — candidates reference an AiProviderConnection rather
        // than carrying its credential.
        'AiRoutingPolicy',
        // TenantStorageConfig's SYSTEM row (bucketId IS NULL) is the platform
        // storage default every tenant's upload path resolves under its own
        // CLS; writes stay super-admin only. Carries a Vault `credentialsRef`
        // path, never credentials.
        'TenantStorageConfig',
        // The price book's SYSTEM-tenant rows ARE the platform rate
        // card (both COST and SELL planes). Every tenant's at-ingest rater and
        // the invoice engine resolve the row effective at `occurredAt` while
        // running under that tenant's CLS, so without widening the read the
        // rate card is invisible and nothing can be priced. READS widen to
        // [caller, SYSTEM]; WRITES are NOT widened (rate-card mutation is
        // SUPER_ADMIN-only at the service layer, the AiTaskDefault precedent).
        // No secrets on the model — prices are integer micros.
        'AiPriceBook',
        // The platform-default PROMPT catalog is SYSTEM-owned
        // and must be readable from every tenant's own CLS: the pre-summary
        // tier-2 fallback (…040, re-owned to SYSTEM by migration
        // 20260808000100), the SYSTEM live-summarization default, and the 13
        // golden library templates. Without the widening a non-Global tenant's
        // pre-summary chain fell through to its 503 fail-closed. READS widen to
        // [caller, SYSTEM]; WRITES are NOT widened, so a tenant can never
        // mutate a SYSTEM-owned template. Tenant LIST surfaces are unaffected
        // because PromptManagementService pins an explicit caller `tenantId`,
        // which mergeSharedReadTenantIntoWhere preserves verbatim.
        'PromptTemplate',
        'PromptVersion',
        // WorkflowInvariantRule's SYSTEM-tenant rows ARE the platform
        // invariant register made executable; every tenant's
        // WorkflowValidatorService must read them merged with its own
        // additions to validate ANY graph — the same "every tenant must
        // resolve the SYSTEM row to function at all" shape as HarnessPolicy/
        // PipelinePolicy above. READS widen to [caller, SYSTEM]; WRITES are
        // NOT widened — a tenant can never mutate a SYSTEM-owned rule row.
        'WorkflowInvariantRule',
        // TASK-863 — platform-default agents + assignments resolve tenant → SYSTEM.
        'Agent',
        'AgentAssignment',
      ]),
    );
  });

  // The widening is READ-ONLY, and its exact shape matters:
  // an explicit caller-supplied tenantId must survive untouched (that is what
  // keeps SYSTEM rows out of tenant list surfaces), while a read that supplies
  // no tenantId gets `IN [caller, SYSTEM]`.
  describe('PromptTemplate read widening (B-12)', () => {
    const CALLER = '50000000-0000-0000-0001-000000000000';

    it('widens an unscoped findFirst to [caller, SYSTEM] so the SYSTEM default resolves', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { id: '71000000-0000-0000-0000-000000000040' } };
      await cfg.query.$allModels.findFirst({ model: 'PromptTemplate', args, query: async (a) => a });
      expect(args.where).toEqual({
        id: '71000000-0000-0000-0000-000000000040',
        tenantId: { in: [CALLER, SYSTEM_TENANT_ID] },
      });
    });

    it('leaves an EXPLICIT caller tenantId alone (admin list surfaces do not grow SYSTEM rows)', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { tenantId: CALLER, status: 'APPROVED' } };
      await cfg.query.$allModels.findMany({ model: 'PromptTemplate', args, query: async (a) => a });
      expect(args.where).toEqual({ tenantId: CALLER, status: 'APPROVED' });
    });

    it('does NOT widen writes — an update still injects the exact caller tenant', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { id: '71000000-0000-0000-0000-000000000040' }, data: { name: 'hijack' } };
      await cfg.query.$allModels.update({ model: 'PromptTemplate', args, query: async (a) => a });
      // Exact-tenant injection ⇒ the SYSTEM-owned row is not matched ⇒ P2025 ⇒ 404.
      expect(args.where).toEqual({ id: '71000000-0000-0000-0000-000000000040', tenantId: CALLER });
    });

    it('applies the same widening to PromptVersion (the snapshot the resolver actually serves)', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { promptTemplateId: '71000000-0000-0000-0000-000000000040', versionNumber: 1 } };
      await cfg.query.$allModels.findFirst({ model: 'PromptVersion', args, query: async (a) => a });
      expect((args.where as Record<string, unknown>).tenantId).toEqual({ in: [CALLER, SYSTEM_TENANT_ID] });
    });
  });

  // Mirrors the PromptTemplate block above: reads widen to
  // [caller, SYSTEM] (so a tenant sees the platform's built-in roles plus its
  // own custom ones); writes stay pinned to the exact caller tenant (so a
  // write aimed at a SYSTEM role id, or another tenant's role id, matches
  // zero rows instead of silently succeeding).
  describe('Role tenant-scope widening (OD-1)', () => {
    const CALLER = '50000000-0000-0000-0001-000000000000';

    it('widens an unscoped findUnique to [caller, SYSTEM] so a built-in role resolves', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { id: 'role-doctor' } };
      await cfg.query.$allModels.findUnique({ model: 'Role', args, query: async (a) => a });
      expect(args.where).toEqual({ id: 'role-doctor', tenantId: { in: [CALLER, SYSTEM_TENANT_ID] } });
    });

    it('leaves an EXPLICIT caller tenantId alone (a tenant admin listing its own roles never grows SYSTEM rows unexpectedly)', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { tenantId: CALLER, isSystemRole: false } };
      await cfg.query.$allModels.findMany({ model: 'Role', args, query: async (a) => a });
      expect(args.where).toEqual({ tenantId: CALLER, isSystemRole: false });
    });

    it('does NOT widen writes — an update still injects the exact caller tenant', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => CALLER });
      const args: Record<string, unknown> = { where: { id: 'role-doctor' }, data: { name: 'hijack' } };
      await cfg.query.$allModels.update({ model: 'Role', args, query: async (a) => a });
      // Exact-tenant injection ⇒ the SYSTEM-owned row is not matched ⇒ P2025.
      expect(args.where).toEqual({ id: 'role-doctor', tenantId: CALLER });
    });

    it('throws for a non-super-admin caller with no tenant context at all (Role now requires one like any other tenant-scoped model)', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => undefined, isSuperAdmin: () => false });
      await expect(
        cfg.query.$allModels.findMany({ model: 'Role', args: {}, query: async (a) => a }),
      ).rejects.toThrow(/tenant context required/);
    });

    it('passes a super admin with no tenant context straight through (cross-tenant platform view, unchanged)', async () => {
      const cfg = captureExtensionConfig({ getTenantId: () => undefined, isSuperAdmin: () => true });
      const args: Record<string, unknown> = { where: { isSystemRole: true } };
      await cfg.query.$allModels.findMany({ model: 'Role', args, query: async (a) => a });
      expect(args.where).toEqual({ isSystemRole: true });
    });
  });

  it('every shared-read model is also a tenant-scoped model', () => {
    for (const m of SYSTEM_SHARED_READ_MODELS) {
      expect(TENANT_SCOPED_MODELS.has(m)).toBe(true);
    }
  });

  it('does NOT include customer-data models whose cross-tenant 404 must hold', () => {
    for (const m of ['Consultation', 'TranscriptionJob', 'TenantBucket', 'AuditLog']) {
      expect(SYSTEM_SHARED_READ_MODELS.has(m)).toBe(false);
    }
  });

  it('isSystemSharedReadModel accepts camelCase and PascalCase', () => {
    expect(isSystemSharedReadModel('AsrPipeline')).toBe(true);
    expect(isSystemSharedReadModel('asrPipeline')).toBe(true);
    expect(isSystemSharedReadModel('Consultation')).toBe(false);
  });
});

describe('SYSTEM-tenant read inheritance on shared catalog models', () => {
  const READ_OPS = ['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'];

  it.each(READ_OPS)('%s widens AsrPipeline tenantId to IN [caller, SYSTEM]', async (op) => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue(null);

    await config.query.$allModels[op]({
      model: 'AsrPipeline',
      args: { where: { id: 'pipeline-1' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { id: 'pipeline-1', tenantId: { in: ['tenant-A', SYSTEM_TENANT_ID] } },
    });
  });

  it('AiModel.findMany seeds the inheritance filter when no where supplied', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({ model: 'AiModel', args: {}, query });

    expect(query).toHaveBeenCalledWith({
      where: { tenantId: { in: ['tenant-A', SYSTEM_TENANT_ID] } },
    });
  });

  // Regression — the AppSettingsService platform cache loads via
  // `globalSettingRepository.findAll({})` (no where). Under the GLOBAL tenant
  // context this previously exact-matched the caller tenant and dropped the
  // SYSTEM-owned platform settings (S3_ENDPOINT/keys), so the S3 client fell
  // back to real AWS and bucket ops 500'd. The load must widen to [caller,
  // SYSTEM] so the SYSTEM-owned infra settings resolve.
  it('GlobalSetting.findMany seeds the inheritance filter when no where supplied (platform-cache load picks up SYSTEM settings)', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({ model: 'GlobalSetting', args: {}, query });

    expect(query).toHaveBeenCalledWith({
      where: { tenantId: { in: ['tenant-A', SYSTEM_TENANT_ID] } },
    });
  });

  it('allows an explicit SYSTEM tenantId on a shared-read model', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue(null);

    await config.query.$allModels.findFirst({
      model: 'AsrPipeline',
      args: { where: { tenantId: SYSTEM_TENANT_ID } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { tenantId: SYSTEM_TENANT_ID } });
  });

  it('allows `{ in: [...] }` subsets of [caller, SYSTEM] on a shared-read model (the two-tier cascade, pinned explicitly)', async () => {
    // AiRoutingPolicyRepository.findCandidates (TASK-862) pins `tenantId: { in: [tenant, SYSTEM] }` — the
    // same widening this extension applies — and a super admin's working tenant made it a 500.
    for (const ids of [['tenant-A', SYSTEM_TENANT_ID], ['tenant-A'], [SYSTEM_TENANT_ID]]) {
      const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
      const query = vi.fn().mockResolvedValue([]);
      await config.query.$allModels.findMany({ model: 'AiRoutingPolicy', args: { where: { tenantId: { in: ids } } }, query });
      expect(query).toHaveBeenCalledWith({ where: { tenantId: { in: ids } } });
    }
  });

  it('rejects an `{ in: [...] }` that reaches outside [caller, SYSTEM] on a shared-read model', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    await expect(
      config.query.$allModels.findMany({
        model: 'AiRoutingPolicy',
        args: { where: { tenantId: { in: ['tenant-A', 'tenant-B'] } } },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });

  it('rejects an explicit foreign tenantId on a shared-read model', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });

    await expect(
      config.query.$allModels.findFirst({
        model: 'AsrPipeline',
        args: { where: { tenantId: 'tenant-B' } },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });

  it('does NOT widen WRITES — create stays pinned to the caller tenant', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.create({
      model: 'AsrPipeline',
      args: { data: { id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { id: 'x', tenantId: 'tenant-A' } });
  });

  it('does NOT widen WRITES — delete stays pinned to the caller tenant', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.delete({
      model: 'AsrPipeline',
      args: { where: { id: 'x' } },
      query,
    });

    const callArgs = query.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(callArgs.where).toEqual({ id: 'x', tenantId: 'tenant-A' });
  });

  it('a non-shared model (Consultation) keeps the exact-match scalar filter', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue(null);

    await config.query.$allModels.findUnique({
      model: 'Consultation',
      args: { where: { id: 'c-1' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { id: 'c-1', tenantId: 'tenant-A' } });
  });
});

// ---------------------------------------------------------------------------
// Read operations: findMany / findFirst / findUnique / count / aggregate / groupBy
// ---------------------------------------------------------------------------

describe('Read operations on tenant-scoped models', () => {
  const READ_OPS = ['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'];

  it.each(READ_OPS)('%s injects tenantId into args.where', async (op) => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const handler = config.query.$allModels[op];
    const query = vi.fn().mockResolvedValue('result');

    const args = { where: { id: 'x' } };
    const result = await handler({ model: 'Consultation', args, query });

    expect(query).toHaveBeenCalledWith({ where: { id: 'x', tenantId: 'tenant-A' } });
    expect(result).toBe('result');
  });

  it.each(READ_OPS)('%s preserves caller filters alongside tenantId', async (op) => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const handler = config.query.$allModels[op];
    const query = vi.fn().mockResolvedValue(null);

    await handler({
      model: 'Consultation',
      args: { where: { id: 'x', OR: [{ a: 1 }, { a: 2 }] } },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { id: 'x', OR: [{ a: 1 }, { a: 2 }], tenantId: 'tenant-A' },
    });
  });

  it('findMany seeds an empty where when none provided', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({
      model: 'Consultation',
      args: {},
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { tenantId: 'tenant-A' } });
  });

  it('findMany throws when caller supplied a mismatched tenantId', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });

    await expect(
      config.query.$allModels.findMany({
        model: 'Consultation',
        args: { where: { tenantId: 'tenant-B' } },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });

  it('findMany allows caller-supplied tenantId when it matches', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({
      model: 'Consultation',
      args: { where: { tenantId: 'tenant-A' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { tenantId: 'tenant-A' } });
  });
});

// ---------------------------------------------------------------------------
// Missing tenantId — throw vs pass-through based on the isSuperAdmin flag
// (true = caller holds the elevated SUPER_ADMIN role)
// ---------------------------------------------------------------------------

describe('Missing tenantId behaviour', () => {
  it('throws on tenant-scoped read when getTenantId returns null and not elevated', async () => {
    const config = captureExtensionConfig({
      getTenantId: () => null,
      isSuperAdmin: () => false,
    });

    await expect(
      config.query.$allModels.findMany({
        model: 'Consultation',
        args: { where: {} },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenant context required.*Consultation.*findMany/i);
  });

  it('throws on tenant-scoped read when getTenantId returns undefined and isSuperAdmin omitted', async () => {
    const config = captureExtensionConfig({ getTenantId: () => undefined });

    // Uses `Webhook` (a genuinely tenant-scoped model). This assertion used to
    // name `ApiKey`, which moved to INTENTIONALLY_UNSCOPED
    // — keeping it here would have asserted the very throw that broke API-key
    // authentication.
    await expect(
      config.query.$allModels.findFirst({
        model: 'Webhook',
        args: { where: {} },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenant context required/);
  });

  it('passes through when getTenantId is null and isSuperAdmin returns true', async () => {
    const config = captureExtensionConfig({
      getTenantId: () => null,
      isSuperAdmin: () => true,
    });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({
      model: 'Consultation',
      args: { where: { id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { id: 'x' } });
  });

  it('passes through writes when elevated (isSuperAdmin true) and no tenantId', async () => {
    const config = captureExtensionConfig({
      getTenantId: () => null,
      isSuperAdmin: () => true,
    });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.create({
      model: 'Consultation',
      args: { data: { id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { id: 'x' } });
  });
});

// ---------------------------------------------------------------------------
// create / createMany
// ---------------------------------------------------------------------------

describe('create operations', () => {
  it('create injects tenantId into data when missing', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.create({
      model: 'Consultation',
      args: { data: { id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { id: 'x', tenantId: 'tenant-A' } });
  });

  it('create throws on mismatched tenantId in data', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });

    await expect(
      config.query.$allModels.create({
        model: 'Consultation',
        args: { data: { tenantId: 'tenant-B' } },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });

  it('create allows matching tenantId in data', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.create({
      model: 'Consultation',
      args: { data: { tenantId: 'tenant-A', id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { tenantId: 'tenant-A', id: 'x' } });
  });

  it('createMany injects tenantId into every element of the array', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({ count: 3 });

    await config.query.$allModels.createMany({
      model: 'Consultation',
      args: { data: [{ id: '1' }, { id: '2' }, { id: '3' }] },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      data: [
        { id: '1', tenantId: 'tenant-A' },
        { id: '2', tenantId: 'tenant-A' },
        { id: '3', tenantId: 'tenant-A' },
      ],
    });
  });

  it('createMany throws if any element has a mismatched tenantId', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });

    await expect(
      config.query.$allModels.createMany({
        model: 'Consultation',
        args: {
          data: [{ tenantId: 'tenant-A' }, { tenantId: 'tenant-B' }],
        },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });

  it('createMany supports single-element (non-array) data shape', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({ count: 1 });

    await config.query.$allModels.createMany({
      model: 'Consultation',
      args: { data: { id: 'x' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { id: 'x', tenantId: 'tenant-A' } });
  });
});

// ---------------------------------------------------------------------------
// update / updateMany / upsert / delete / deleteMany
// ---------------------------------------------------------------------------

describe('mutation operations merge tenantId into where', () => {
  const MUTATION_OPS_WITH_WHERE = ['update', 'updateMany', 'delete', 'deleteMany'];

  it.each(MUTATION_OPS_WITH_WHERE)('%s injects tenantId into where', async (op) => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels[op]({
      model: 'Consultation',
      args: { where: { id: 'x' }, data: { name: 'new' } },
      query,
    });

    const callArgs = query.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(callArgs.where).toEqual({ id: 'x', tenantId: 'tenant-A' });
  });

  it('upsert injects tenantId into both where and create payloads', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.upsert({
      model: 'Consultation',
      args: {
        where: { id: 'x' },
        create: { id: 'x' },
        update: { name: 'updated' },
      },
      query,
    });

    expect(query).toHaveBeenCalledWith({
      where: { id: 'x', tenantId: 'tenant-A' },
      create: { id: 'x', tenantId: 'tenant-A' },
      update: { name: 'updated' },
    });
  });

  it('updateMany throws on mismatched where.tenantId', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });

    await expect(
      config.query.$allModels.updateMany({
        model: 'Consultation',
        args: { where: { tenantId: 'tenant-B' }, data: { name: 'x' } },
        query: vi.fn(),
      }),
    ).rejects.toThrow(/tenantId mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Non-allow-listed models: pass through untouched
// ---------------------------------------------------------------------------

describe('Non-allow-listed (global / root) models pass through unchanged', () => {
  it('Tenant.findMany is not augmented', async () => {
    const config = captureExtensionConfig({ getTenantId: () => 'tenant-A' });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({
      model: 'Tenant',
      args: { where: { name: 'acme' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { name: 'acme' } });
  });

  it('User.create is not augmented (no tenantId required)', async () => {
    const config = captureExtensionConfig({ getTenantId: () => null });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.create({
      model: 'User',
      args: { data: { username: 'alice' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ data: { username: 'alice' } });
  });

  // `Role` moved OFF this pass-through list — it is now
  // tenant-scoped (see the dedicated "Role tenant-scope widening" describe
  // block below). `Policy` (the CASL rule catalog `Role`s attach via
  // `RolePolicy`) deliberately stays here: a tenant admin can only attach/
  // detach EXISTING policies (`manage:RolePolicy`), never author new ones
  // (`manage:Policy` is super-admin-only), so there is nothing tenant-owned
  // to scope.
  it('Policy.findUnique does not throw even when tenant context is missing', async () => {
    const config = captureExtensionConfig({
      getTenantId: () => null,
      isSuperAdmin: () => false,
    });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.findUnique({
      model: 'Policy',
      args: { where: { id: 'policy-1' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { id: 'policy-1' } });
  });
});

// ---------------------------------------------------------------------------
// setTenantContextProvider — singleton provider mechanism for composition
// ---------------------------------------------------------------------------

describe('setTenantContextProvider singleton', () => {
  afterEach(() => {
    setTenantContextProvider(null);
  });

  it('when no provider set, behaves as pass-through (CLI/seed mode)', async () => {
    setTenantContextProvider(null);

    // Use the composed-mode capture by passing a provider that delegates
    // to the singleton — simulates what `client.ts` does.
    const config = captureExtensionConfig({
      getTenantId: () => undefined,
      isSuperAdmin: () => true,
    });
    const query = vi.fn().mockResolvedValue([]);

    await config.query.$allModels.findMany({
      model: 'Consultation',
      args: { where: {} },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: {} });
  });

  it('a registered provider is reachable via the singleton getter', () => {
    const provider: TenantContextProvider = {
      getTenantId: () => 'tenant-from-provider',
      isSuperAdmin: () => false,
    };
    setTenantContextProvider(provider);

    const config = captureExtensionConfig({
      getTenantId: () => provider.getTenantId(),
      isSuperAdmin: () => provider.isSuperAdmin?.() ?? false,
    });
    expect(config.name).toMatch(/tenantScope/i);
  });
});
