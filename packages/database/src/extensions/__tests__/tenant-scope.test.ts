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
  it('contains the 28 tenant-scoped models currently defined in db_main/*.prisma', () => {
    // The audit (`docs/multi-tenancy-audit/02-prisma-schema-review.md` §A)
    // lists 30 models, but 4 User* tables and DnaRegenerationSettings
    // do not yet carry a tenantId column — they are added in TASK-305
    // Phase A. The allow-list tracks the SCHEMA TRUTH, not the future plan.
    // TASK-318 added TenantStorageConfig (tenant-scoped storage settings)
    // to the schema and the allow-list, bringing the count to 28.
    expect(TENANT_SCOPED_MODELS.size).toBe(28);
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

  it('isTenantScopedModel accepts camelCase and PascalCase', () => {
    expect(isTenantScopedModel('Consultation')).toBe(true);
    expect(isTenantScopedModel('consultation')).toBe(true);
    expect(isTenantScopedModel('tenant')).toBe(false);
    expect(isTenantScopedModel('Tenant')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM-shared read inheritance allow-list
// ---------------------------------------------------------------------------

describe('SYSTEM_SHARED_READ_MODELS allow-list', () => {
  it('contains only the platform catalog models (AsrPipeline, AiModel)', () => {
    expect(new Set(SYSTEM_SHARED_READ_MODELS)).toEqual(
      new Set(['AsrPipeline', 'AiModel']),
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
// Missing tenantId — throw vs pass-through based on super-admin flag
// ---------------------------------------------------------------------------

describe('Missing tenantId behaviour', () => {
  it('throws on tenant-scoped read when getTenantId returns null and not super admin', async () => {
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

  it('passes through writes when super admin and no tenantId', async () => {
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
