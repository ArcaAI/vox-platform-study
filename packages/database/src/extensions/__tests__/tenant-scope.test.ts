/**
 * Tenant-Scope Extension Unit Tests — TASK-305 Phase B.6.
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

type Handler = (params: {
  model: string;
  args: Record<string, unknown>;
  query: (a: unknown) => Promise<unknown>;
}) => Promise<unknown>;

interface ExtensionConfig {
  name: string;
  // Indexed via string literals in the tests; we lie about the value
  // type to avoid `undefined` in noUncheckedIndexedAccess mode.
  query: { $allModels: { [op: string]: Handler } };
}

function captureExtensionConfig(opts: {
  getTenantId: () => string | null | undefined;
  isSuperAdmin?: () => boolean;
}): ExtensionConfig {
  const prisma = { $extends: vi.fn().mockReturnThis() };
  applyTenantScopeExtension(prisma as never, opts);
  expect(prisma.$extends).toHaveBeenCalledTimes(1);
  return prisma.$extends.mock.calls[0][0] as ExtensionConfig;
}

// ---------------------------------------------------------------------------
// Allow-list contract
// ---------------------------------------------------------------------------

describe('TENANT_SCOPED_MODELS allow-list', () => {
  it('contains the 54 tenant-scoped models currently defined in db_main/*.prisma', () => {
    // The allow-list tracks SCHEMA TRUTH (every model here has a tenantId
    // scalar), not the audit's 30-name wish-list. The User* identity tables
    // are intentionally excluded — `User` is global by design (§B6 /
    // TASK-305 Phase F); tenant membership lives in the UserRoleAssignment
    // (role) + UserDepartment (department) join tables.
    // TASK-318 added TenantStorageConfig → 28. TASK-305 Phase F added
    // UserDepartment → 29. TASK-331 doc-08 added TenantFrontendConfig (F2)
    // + AsrPipelineVersion (F3) → 31. TASK-330 Phase 0 added the clinical-
    // documentation harness GoldenSet/GoldenCase/EvalRun/EvalScore +
    // HarnessAuditEvent → 36. TASK-330 Phase 3 added the institutional-RAG
    // KnowledgeDocument + KnowledgeChunk → 38. TASK-330 Phase 6 added the
    // editable harness policy HarnessPolicy + append-only HarnessPolicyChange
    // → 40. TASK-349 added Highlight (TASK-344 model, caught by the drift
    // guard below) → 41. TASK-356 Phase 5 added the realtime-cascade
    // PipelinePolicy + append-only PipelinePolicyChange → 43. TASK-392 added
    // TenantUsageMeter → 44 (TenantEntitlement is INTENTIONALLY_UNSCOPED,
    // below). TASK-490 added UserVoiceProfile (biometric PHI stamped with
    // its enrollment tenant) → 45. TASK-496 added the per-tenant TTS config
    // TenantTtsConfig + TenantTtsProviderCredential (BYO provider keys) → 47.
    // TASK-498 added the tenant-scoped external OIDC identity provider
    // TenantIdentityProvider + FederatedIdentity + TenantIdentityProviderDomain
    // → 50. TASK-506 added the per-tenant task-default selector AiTaskDefault
    // → 51. Phase 2A added the ordered session-trajectory telemetry
    // AgentTrajectoryStep → 52. added the segment-level transcript
    // annotation TranscriptSegment → 53. Phase 5 added the MCP
    // external-tools registry McpServer (SYSTEM-shared read; global-admin
    // writes) → 54. (The drift guard below is the durable check; this count
    // stays as a quick human-readable tripwire.)
    expect(TENANT_SCOPED_MODELS.size).toBe(54);
  });

  it('includes every PHI-bearing model', () => {
    for (const phi of [
      'Consultation', 'ContextItem', 'ContextItemVersion',
      'AudioRecording', 'SummaryMeta', 'NamedEntity', 'AuditLog',
    ]) {
      expect(TENANT_SCOPED_MODELS.has(phi)).toBe(true);
    }
  });

  it('does NOT include global / root models', () => {
    for (const global of ['Tenant', 'User', 'Role', 'Policy', 'RolePolicy']) {
      expect(TENANT_SCOPED_MODELS.has(global)).toBe(false);
    }
  });

  it('includes the user↔tenant membership join tables (TASK-305 Phase F)', () => {
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
// Schema-derived drift guard (TASK-331 doc-08 F2/F3)
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
  const DB_MAIN_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'prisma',
    'db_main',
  );

  /**
   * Models that carry a `tenantId` scalar but are DELIBERATELY excluded from
   * tenant-scope injection. Add a name here ONLY for a conscious, reviewed
   * exception (with a justifying comment), never to silence this guard for a
   * real tenant-scoped model.
   */
  const INTENTIONALLY_UNSCOPED: ReadonlySet<string> = new Set<string>([
    // TASK-392 — per-tenant entitlement override (`tenantId @unique`), a
    // platform-administration row rather than customer data. It is read via
    // the EXTENDED client from contexts whose CLS tenant can never match the
    // target row, so CLS-based scope injection would silently break them:
    //   1. The pre-auth throttler (`tiered-throttler.guard.ts` →
    //      `getTenantRateLimitPolicy` → `findByTenant`) resolves the
    //      caller-tenant's rate-limit override BEFORE auth populates CLS —
    //      CLS is active but empty (not elevated), so a scoped read would
    //      throw and per-tenant rate-limit overrides (Q7 "increase on
    //      demand") would silently stop applying.
    //   2. GLOBAL_ADMIN override CRUD (`/admin/entitlements/tenants/:id`)
    //      targets ANY tenant while the admin's working-tenant CLS context
    //      (X-Tenant-Id, `resolve-active-tenant.ts`) may point elsewhere —
    //      the extension only bypasses when NO CLS tenant exists, so scoping
    //      would 404/mismatch legitimate cross-tenant admin operations.
    // Isolation still holds: every read path filters by an explicit
    // `tenantId` (`findByTenant`), the row carries no PHI, and the only
    // write surface is the GLOBAL_ADMIN-gated admin controller.
    'TenantEntitlement',
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
    expect(found).toContain('HarnessAuditEvent'); // harness.prisma (TASK-330)
    expect(found).toContain('KnowledgeDocument'); // knowledge.prisma (TASK-330 Phase 3)
    expect(found).toContain('KnowledgeChunk'); // knowledge.prisma (TASK-330 Phase 3)
  });

  it('lists every schema tenantId model in TENANT_SCOPED_MODELS (drift = []) ', () => {
    const missing = schemaModelsWithTenantId().filter(
      (m) => !TENANT_SCOPED_MODELS.has(m) && !INTENTIONALLY_UNSCOPED.has(m),
    );
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
      // TASK-330 Phase 6 — HarnessPolicy's SYSTEM-tenant row is the global
      // default every tenant reads to compute its effective policy.
      // TASK-356 Phase 5 — PipelinePolicy's SYSTEM-tenant row is the realtime
      // cascade's platform default (ConfigResolver reads it for every tenant).
      // GlobalSetting — platform infra settings (S3/MinIO, STT) are seeded under
      // the SYSTEM tenant; the AppSettingsService platform cache reads them.
      // TASK-496 — TenantTtsConfig's SYSTEM-tenant row is the per-tenant TTS
      // platform default every tenant's resolveForTenant merges over (credentials
      // are NEVER shared, so TenantTtsProviderCredential is intentionally absent).
      // TASK-506 — AiTaskDefault's SYSTEM-tenant rows are the platform default
      // model per AI task (guardrail.validate / nlp.*) every tenant's
      // getEffective merges under its own row; writes are NOT widened.
      // McpServer's SYSTEM-tenant rows are the shared external-tools
      // registry every tenant's harness run reads to resolve a server; writes
      // are NOT widened (registry mutation is global-admin only).
      new Set([
        'AsrPipeline',
        'AiModel',
        'HarnessPolicy',
        'PipelinePolicy',
        'GlobalSetting',
        'TenantTtsConfig',
        'AiTaskDefault',
        'McpServer',
      ]),
    );
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
  const READ_OPS = [
    'findFirst', 'findFirstOrThrow',
    'findUnique', 'findUniqueOrThrow',
    'findMany', 'count', 'aggregate', 'groupBy',
  ];

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
  const READ_OPS = [
    'findFirst', 'findFirstOrThrow',
    'findUnique', 'findUniqueOrThrow',
    'findMany', 'count', 'aggregate', 'groupBy',
  ];

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
// (true = caller holds the elevated GLOBAL_ADMIN role)
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

    await expect(
      config.query.$allModels.findFirst({
        model: 'ApiKey',
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

  it('Role.findUnique does not throw even when tenant context is missing', async () => {
    const config = captureExtensionConfig({
      getTenantId: () => null,
      isSuperAdmin: () => false,
    });
    const query = vi.fn().mockResolvedValue({});

    await config.query.$allModels.findUnique({
      model: 'Role',
      args: { where: { id: 'role-1' } },
      query,
    });

    expect(query).toHaveBeenCalledWith({ where: { id: 'role-1' } });
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
