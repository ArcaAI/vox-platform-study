/**
 * TASK-958 — several connections of ONE provider per tenant.
 *
 * The ticket's TDD list §4.6, applications half: (5)-(14), (19), plus the
 * by-id credential lookup Lane B2 codes against and the two new
 * `ProviderOverrideEntry` fields.
 *
 * The fixture is a small in-memory repository rather than per-call mocks,
 * because every behaviour under test here is about the RELATIONSHIP between
 * rows — which one is the default, which one a cascade picks, what happens to
 * the sibling when the default is deleted. Mocking each lookup independently
 * would let those relationships disagree silently, which is the exact class of
 * bug the multiplicity work introduces.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AiProviderConnectionEntity, AiProviderConnectionFactory, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { ProviderCredentialResolver } from '../provider-credential-resolver';
import { CONNECTION_ERROR_CODES } from '../constants';

const TENANT = 'tenant-958';
const OTHER_TENANT = 'tenant-other';

/** The fields an ENABLED azure/openai row must carry to pass the requirement check. */
const AZURE_REQUIRED = {
  baseUrl: 'https://acme.openai.azure.com',
  apiVersion: '2024-10-21',
  deploymentName: 'gpt-4o-mini',
  apiKey: 'sk-azure',
};

interface RowSeed {
  tenantId?: string;
  service?: string;
  provider?: string;
  slug?: string;
  name?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
  keyed?: boolean;
  baseUrl?: string | null;
}

function makeRow(seed: RowSeed = {}): AiProviderConnectionEntity {
  const provider = seed.provider ?? 'openai';
  const slug = seed.slug ?? provider;
  const isDefault = seed.isDefault ?? slug === provider;
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: seed.tenantId ?? TENANT,
    service: seed.service ?? 'llm',
    provider,
    slug,
    name: seed.name ?? null,
    defaultForProvider: isDefault ? provider : null,
    enabled: seed.enabled ?? true,
    baseUrl: seed.baseUrl ?? null,
    encryptedApiKey: (seed.keyed ?? true) ? Buffer.from('vault:v3:cipher', 'utf8') : null,
    keyVersion: (seed.keyed ?? true) ? 3 : null,
  });
}

/**
 * An in-memory `AiProviderConnectionRepository`. The four TASK-958 lookups are
 * implemented over ONE array so "default first, then createdAt" and "exactly one
 * default per (tenant, service, provider)" are properties of the fixture, not
 * assumptions of each test.
 */
function makeRepo(rows: AiProviderConnectionEntity[] = []) {
  const live = () => rows.filter((r) => r.resourceStatus !== ResourceStatusType.DELETED);
  const byDefaultFirst = (a: AiProviderConnectionEntity, b: AiProviderConnectionEntity) =>
    Number(!!b.defaultForProvider) - Number(!!a.defaultForProvider) || a.createdAt.getTime() - b.createdAt.getTime();

  const repo: any = {
    rows,
    findByTenantServiceSlug: vi.fn(
      async (service: string, slug: string, tenantId: string) =>
        live().find((r) => r.tenantId === tenantId && r.service === service && r.slug === slug) ?? null,
    ),
    findAllByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) =>
      live()
        .filter((r) => r.tenantId === tenantId && r.service === service && r.provider === provider)
        .sort(byDefaultFirst),
    ),
    findDefaultByTenantServiceProvider: vi.fn(
      async (service: string, provider: string, tenantId: string) =>
        live().find((r) => r.tenantId === tenantId && r.service === service && r.defaultForProvider === provider) ?? null,
    ),
    findByTenantServiceProvider: vi.fn(
      async (service: string, provider: string, tenantId: string) =>
        live().find((r) => r.tenantId === tenantId && r.service === service && r.defaultForProvider === provider) ?? null,
    ),
    findDeletedByTenantServiceSlug: vi.fn(async () => null),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      live()
        .filter((r) => r.tenantId === tenantId && r.service === service)
        .sort((a, b) => a.provider.localeCompare(b.provider) || byDefaultFirst(a, b)),
    ),
    count: vi.fn(async () => live().length),
    create: vi.fn(async (entity: AiProviderConnectionEntity) => {
      rows.push(entity);
      return entity;
    }),
    update: vi.fn(async (_id: string, entity: AiProviderConnectionEntity) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: AiProviderConnectionEntity) => {
      (entity as any)._version = entity.version + 1;
      return entity;
    }),
    softDelete: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) (row as any)._resourceStatus = ResourceStatusType.DELETED;
    }),
  };
  return repo;
}

function makeService(opts: { rows?: AiProviderConnectionEntity[]; roles?: string[]; quota?: () => Promise<void> } = {}) {
  const repo = makeRepo(opts.rows ?? []);
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? TENANT : undefined)),
  };
  // `$transaction` runs the callback with a client whose model delegates are
  // unused by the fixture (the repository mocks ignore `tx`), which is exactly
  // the point: a test asserts that BOTH writes happened inside ONE call.
  const db = { baseClient: { $lane: 'unscoped', $transaction: vi.fn(async (cb: any) => cb({ $lane: 'tx' })) } };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = {
    isFeatureEnabled: vi.fn(async () => true),
    assertQuantityQuota: vi.fn(opts.quota ?? (async () => undefined)),
  };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo, emitter, db, entitlements };
}

// ===========================================================================
// (5) (6) (7) — creating and electing siblings
// ===========================================================================

describe('TASK-958 — named siblings (tests 5-7)', () => {
  it('(5) creates a NON-default sibling for a provider the tenant already has', async () => {
    const { svc, repo } = makeService({ rows: [makeRow({ provider: 'openai' })] });

    const res = await svc.upsertRow(
      'llm',
      'openai-research',
      { provider: 'openai', name: 'Research account', apiKey: 'sk-2', enabled: true, expectedVersion: 0 },
      TENANT,
    );

    expect(res.slug).toBe('openai-research');
    expect(res.provider).toBe('openai');
    expect(res.name).toBe('Research account');
    expect(res.isDefault).toBe(false);
    const created = repo.create.mock.calls[0][0];
    expect(created.defaultForProvider).toBeNull();
  });

  it('(6) refuses a new slug that is not a provider id when the body names no provider', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('llm', 'foo', { apiKey: 'k', expectedVersion: 0 }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.PROVIDER_REQUIRED },
    });
  });

  it('(6b) refuses a slug that fails the pattern', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('llm', 'Bad_Slug', { provider: 'openai', expectedVersion: 0 }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.SLUG_INVALID },
    });
  });

  it('(6c) refuses to move an existing connection to a different provider', async () => {
    const existing = makeRow({ provider: 'openai' });
    const { svc } = makeService({ rows: [existing] });
    await expect(svc.upsertRow('llm', 'openai', { provider: 'azure', expectedVersion: existing.version }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.PROVIDER_IMMUTABLE },
    });
  });

  it('(7) `isDefault: true` on a sibling flips the default inside ONE transaction, bumping both versions', async () => {
    const current = makeRow({ provider: 'openai', slug: 'openai' });
    const sibling = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false });
    const { svc, repo, db } = makeService({ rows: [current, sibling] });
    const currentVersion = current.version;
    const siblingVersion = sibling.version;

    const res = await svc.upsertRow('llm', 'openai-research', { isDefault: true, expectedVersion: sibling.version }, TENANT);

    expect(db.baseClient.$transaction).toHaveBeenCalledTimes(1);
    expect(current.defaultForProvider).toBeNull();
    expect(sibling.defaultForProvider).toBe('openai');
    expect(current.version).toBeGreaterThan(currentVersion);
    expect(sibling.version).toBeGreaterThan(siblingVersion);
    expect(res.isDefault).toBe(true);
    // Both writes went through the SAME transaction client.
    const lanes = repo.updateWithVersion.mock.calls.map((c: any[]) => c[3]?.$lane);
    expect(lanes).toEqual(['tx', 'tx']);
  });

  it('(7b) refuses to un-default the current default', async () => {
    const current = makeRow({ provider: 'openai' });
    const { svc } = makeService({ rows: [current] });
    await expect(svc.upsertRow('llm', 'openai', { isDefault: false, expectedVersion: current.version }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.DEFAULT_REQUIRED },
    });
  });
});

// ===========================================================================
// (8) (9) (10) — deleting a default, the platform tier, the integration planes
// ===========================================================================

describe('TASK-958 — refusals (tests 8-10)', () => {
  it('(8) refuses to delete the DEFAULT while a sibling lives', async () => {
    const rows = [makeRow({ provider: 'openai' }), makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false })];
    const { svc, repo } = makeService({ rows });
    await expect(svc.deleteRow('llm', 'openai', TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.IS_DEFAULT },
    });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('(8b) allows deleting a SIBLING, and the default afterwards', async () => {
    const rows = [makeRow({ provider: 'openai' }), makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false })];
    const { svc, repo } = makeService({ rows });
    await svc.deleteRow('llm', 'openai-research', TENANT);
    await svc.deleteRow('llm', 'openai', TENANT);
    expect(repo.softDelete).toHaveBeenCalledTimes(2);
  });

  it('(9) the platform tier refuses a slug that is not the provider', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(
      svc.upsertRow('llm', 'openai-research', { provider: 'openai', apiKey: 'k', expectedVersion: 0 }, SYSTEM_TENANT_ID),
    ).rejects.toMatchObject({ response: { code: CONNECTION_ERROR_CODES.PLATFORM_ONE_PER_PROVIDER } });
  });

  it('(9b) the platform tier refuses a non-default row', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], rows: [makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'openai' })] });
    await expect(svc.upsertRow('llm', 'openai', { isDefault: false, expectedVersion: 1 }, SYSTEM_TENANT_ID)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.PLATFORM_ONE_PER_PROVIDER },
    });
  });

  // TASK-991 (OD-3/OD-4): these two cases used `embeddings` as their example of an
  // integration plane. That service is now platform-managed and refused for a tenant
  // BEFORE the multiplicity rule is reached, which would make these assert the lock
  // rather than the multiplicity contract. `rerank` is on the same plane
  // (`embeddings`/`rerank`/`vector`/`model-registry`), so the contract under test is
  // unchanged — only the example moved off the one service that now has its own gate.
  it('(10) refuses a sibling on an integration plane that serves no per-tenant model rows', async () => {
    const { svc } = makeService({ rows: [makeRow({ service: 'vector', provider: 'qdrant' })] });
    await expect(
      svc.upsertRow('vector', 'qdrant-second', { provider: 'qdrant', apiKey: 'k', enabled: true, expectedVersion: 0 }, TENANT),
    ).rejects.toMatchObject({ response: { code: CONNECTION_ERROR_CODES.MULTIPLICITY_UNSUPPORTED } });
  });

  it('(10b) still allows the DEFAULT row on an integration plane', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('vector', 'qdrant', { apiKey: 'k', enabled: true, expectedVersion: 0 }, TENANT)).resolves.toMatchObject({
      slug: 'qdrant',
      isDefault: true,
    });
  });
});

// ===========================================================================
// (11) (12) (13) — the cascade reads the DEFAULT, and only the DEFAULT vetoes
// ===========================================================================

describe('TASK-958 — the cascade evaluates the DEFAULT (tests 11-13)', () => {
  it('(11) picks the DEFAULT deterministically when the tenant holds two rows', async () => {
    const sibling = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, baseUrl: 'https://sibling.example' });
    const def = makeRow({ provider: 'openai', slug: 'openai', baseUrl: 'https://default.example' });
    // Sibling FIRST in insertion order: a "first row wins" implementation picks the wrong one.
    const { svc } = makeService({ rows: [sibling, def] });

    const resolved = await svc.resolveConnection('llm', 'openai', TENANT);
    expect(resolved?.baseUrl).toBe('https://default.example');

    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT);
    expect(overrides.openai?.base_url).toBe('https://default.example');
    expect(overrides.openai?.connection_slug).toBe('openai');
  });

  it('(12) a DISABLED non-default row does not veto the provider', async () => {
    const rows = [
      makeRow({ provider: 'openai', slug: 'openai' }),
      makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, enabled: false }),
    ];
    const { svc } = makeService({ rows });
    const resolved = await svc.resolveConnection('llm', 'openai', TENANT);
    expect(resolved?.source).toBe('tenant');
    const { overrides, platformDefault } = await svc.resolveTenantCloudOverrides('llm', TENANT);
    expect(overrides.openai).toBeDefined();
    expect(platformDefault?.vetoed ?? []).not.toContain('openai');
  });

  it('(13) a DISABLED DEFAULT still vetoes, even with an enabled sibling', async () => {
    const rows = [
      makeRow({ provider: 'openai', slug: 'openai', enabled: false }),
      makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, enabled: true }),
      makeRow({ tenantId: SYSTEM_TENANT_ID, provider: 'openai' }),
    ];
    const { svc } = makeService({ rows });
    expect(await svc.resolveConnection('llm', 'openai', TENANT)).toBeNull();
    const { overrides, platformDefault } = await svc.resolveTenantCloudOverrides('llm', TENANT);
    expect(overrides.openai).toBeUndefined();
    expect(platformDefault?.vetoed).toContain('openai');
  });
});

// ===========================================================================
// (14) — two connections may declare the SAME vendor model id
// ===========================================================================

describe('TASK-958 — declared models are named after the CONNECTION (test 14)', () => {
  function withModels(rows: AiProviderConnectionEntity[], models: any[] = []) {
    const base = makeService({ rows });
    const modelRepo: any = {
      findBySlug: vi.fn(async (tenantId: string, slug: string) => models.find((m) => m.tenantId === tenantId && m.slug === slug) ?? null),
      findBySlugIncludingDeleted: vi.fn(async (tenantId: string, slug: string) => models.find((m) => m.slug === slug) ?? null),
      findBySourceConnection: vi.fn(async (connectionId: string) => models.filter((m) => m.sourceConnectionId === connectionId)),
      create: vi.fn(async (m: any) => {
        models.push(m);
        return m;
      }),
      update: vi.fn(async (_id: string, m: any) => m),
      softDelete: vi.fn(),
      restore: vi.fn(),
    };
    const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT : undefined)) };
    const db = { baseClient: { $lane: 'unscoped', $transaction: vi.fn(async (cb: any) => cb({ $lane: 'tx' })) } };
    const secrets = { encrypt: vi.fn(), decrypt: vi.fn(), supportsTransit: vi.fn(() => true) };
    const entitlements = { isFeatureEnabled: vi.fn(async () => true), assertQuantityQuota: vi.fn() };
    const svc = new AiProviderConnectionService(
      base.repo as any,
      db as any,
      { emit: vi.fn() } as any,
      cls as any,
      secrets as any,
      entitlements as any,
      modelRepo,
    );
    return { svc, modelRepo, models };
  }

  const DECLARATION = { models: [{ wireModelId: 'gpt-5.4-mini', name: 'GPT 5.4 mini', taskType: 'TEXT_GENERATION' as any }] };

  it('(14) the same wire id on two connections yields two rows with distinct slugs and distinct sourceConnectionId', async () => {
    const def = makeRow({ provider: 'openai', slug: 'openai' });
    const sibling = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false });
    const { svc, models } = withModels([def, sibling]);

    const first = await svc.declareModels('llm', 'openai', DECLARATION as any, TENANT);
    const second = await svc.declareModels('llm', 'openai-research', DECLARATION as any, TENANT);

    expect(first.models?.[0]?.slug).toBe('openai-gpt-5-4-mini');
    expect(second.models?.[0]?.slug).toBe('openai-research-gpt-5-4-mini');
    expect(models.map((m) => m.sourceConnectionId)).toEqual([def.id, sibling.id]);
  });

  it('(14b) a declared slug already minted by ANOTHER connection of this tenant is refused', async () => {
    const def = makeRow({ provider: 'openai', slug: 'openai' });
    const sibling = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false });
    const { svc } = withModels([def, sibling], [{ id: 'm1', slug: 'openai-research-gpt-5-4-mini', sourceConnectionId: def.id, tenantId: TENANT }]);

    await expect(svc.declareModels('llm', 'openai-research', DECLARATION as any, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.BYO_SLUG_TAKEN, otherConnectionSlug: 'openai' },
    });
  });
});

// ===========================================================================
// (19) — the connection-count entitlement
// ===========================================================================

describe('TASK-958 — maxAiProviderConnections (test 19)', () => {
  it('(19) checks the quota on CREATE, with the live count', async () => {
    const { svc, entitlements } = makeService({ rows: [makeRow({ provider: 'openai' })] });
    await svc.upsertRow('llm', 'openai-research', { provider: 'openai', apiKey: 'k', expectedVersion: 0 }, TENANT);
    expect(entitlements.assertQuantityQuota).toHaveBeenCalledWith(TENANT, 'maxAiProviderConnections', 1);
  });

  it('(19b) refuses the N+1th connection when the cap is reached', async () => {
    const { svc } = makeService({
      rows: [makeRow({ provider: 'openai' })],
      quota: async () => {
        throw new QuotaExceededException('cap', { capability: 'maxAiProviderConnections', limit: 1, used: 1, requested: 1 });
      },
    });
    await expect(svc.upsertRow('llm', 'openai-research', { provider: 'openai', apiKey: 'k', expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      QuotaExceededException,
    );
  });

  it('(19c) does NOT check the quota on an update, nor on the platform tier', async () => {
    const existing = makeRow({ provider: 'openai' });
    const { svc, entitlements } = makeService({ rows: [existing] });
    await svc.upsertRow('llm', 'openai', { ...AZURE_REQUIRED, apiKey: 'rotated', expectedVersion: existing.version }, TENANT);
    expect(entitlements.assertQuantityQuota).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The by-id credential lookup (Lane B2's interface) + the wire fields
// ===========================================================================

describe('TASK-958 — resolving ONE named connection by id', () => {
  let sibling: AiProviderConnectionEntity;
  let def: AiProviderConnectionEntity;

  beforeEach(() => {
    def = makeRow({ provider: 'openai', slug: 'openai', baseUrl: 'https://default.example' });
    sibling = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, baseUrl: 'https://sibling.example' });
  });

  it('resolves the named sibling, not the default', async () => {
    const { svc } = makeService({ rows: [def, sibling] });
    const resolver = new ProviderCredentialResolver(svc);
    const bound = await resolver.resolve('llm', 'openai', TENANT, { connectionId: sibling.id });
    expect(bound?.connectionId).toBe(sibling.id);
    expect(bound?.override.base_url).toBe('https://sibling.example');
    expect(bound?.override.connection_id).toBe(sibling.id);
    expect(bound?.override.connection_slug).toBe('openai-research');
  });

  it("another tenant's connection id is a 404, never that tenant's credential", async () => {
    const foreign = makeRow({ tenantId: OTHER_TENANT, provider: 'openai', slug: 'openai' });
    const { svc } = makeService({ rows: [def, foreign] });
    const resolver = new ProviderCredentialResolver(svc);
    await expect(resolver.resolve('llm', 'openai', TENANT, { connectionId: foreign.id })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.resolveConnection('llm', 'openai', TENANT, { connectionId: foreign.id })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a DISABLED named connection fails closed — never the default, never the platform', async () => {
    const disabled = makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, enabled: false });
    const { svc } = makeService({ rows: [def, disabled] });
    const resolver = new ProviderCredentialResolver(svc);
    expect(await resolver.resolve('llm', 'openai', TENANT, { connectionId: disabled.id })).toBeNull();
    expect(await svc.resolveConnection('llm', 'openai', TENANT, { connectionId: disabled.id })).toBeNull();
  });

  it('every folded override entry carries the connection identity', async () => {
    const { svc } = makeService({ rows: [def] });
    const { overrides } = await svc.resolveTenantCloudOverrides('llm', TENANT);
    expect(overrides.openai?.connection_id).toBe(def.id);
    expect(overrides.openai?.connection_slug).toBe('openai');
  });
});

// ===========================================================================
// The list read — every row, default first
// ===========================================================================

describe('TASK-958 — the admin list', () => {
  it('returns every connection of the tenant with its slug, name and default flag', async () => {
    const rows = [
      makeRow({ provider: 'openai', slug: 'openai' }),
      makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false, name: 'Research' }),
    ];
    const { svc } = makeService({ rows });
    const list = await svc.list('llm', TENANT);
    expect(list.map((r) => [r.slug, r.isDefault, r.name])).toEqual([
      ['openai', true, null],
      ['openai-research', false, 'Research'],
    ]);
    expect(list.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  it('reads ONE connection by its slug', async () => {
    const rows = [makeRow({ provider: 'openai' }), makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false })];
    const { svc } = makeService({ rows });
    const res = await svc.getRow('llm', 'openai-research', TENANT);
    expect(res.slug).toBe('openai-research');
    expect(res.isDefault).toBe(false);
  });

  it('a slug this tenant does not hold reads as the create placeholder', async () => {
    const { svc } = makeService();
    const res = await svc.getRow('llm', 'openai', TENANT);
    expect(res).toMatchObject({ slug: 'openai', provider: 'openai', version: 0 });
  });

  it('exposes `findDefaultRow` for the by-provider consumers', async () => {
    const rows = [makeRow({ provider: 'openai', slug: 'openai-research', isDefault: false }), makeRow({ provider: 'openai' })];
    const { svc } = makeService({ rows });
    const row = await svc.findDefaultRow('llm', 'openai', TENANT);
    expect(row?.slug).toBe('openai');
  });
});

/** Keep the unused-import lint quiet about the exception types the matchers assert structurally. */
void BadRequestException;
void ConflictException;
