/**
 * TASK-991 OD-3 / OD-4 — `embeddings` is PLATFORM-MANAGED.
 *
 * Owner decision, 2026-09-19:
 *
 * > **OD-3** — the TEXT embedding model used for text feature extraction is
 * > FIXED for every tenant. No tenant may change it. It stays CONFIG (platform
 * > admin, SYSTEM tier), not a literal.
 * > **OD-4** — the embeddings ENDPOINT is fixed together with the model. A
 * > tenant may NOT point embeddings at its own account.
 *
 * A DELIBERATE, owner-approved narrowing of the tenant-first rule, of the kind
 * `00-project-context.md` admits as a documented exception — not a violation to
 * be "fixed" back. The harness half already obeys it
 * (`resolve_embeddings_credential` reads the SYSTEM `embeddings:tei-embed` row
 * and nothing else), and this is the reason the gateway must refuse the write
 * too: without the refusal a tenant admin can still SAVE an `embeddings` row and
 * watch it do nothing. A silently inert setting is strictly worse than a 403
 * that says who owns the knob.
 *
 * What is pinned here:
 *
 *  - a TENANT-tier create or update for `service: 'embeddings'` is a 403, for
 *    EVERY provider a tenant could name;
 *  - a SUPER_ADMIN writing the SYSTEM tier is untouched, and so is the
 *    pre-existing "SYSTEM is super-admins-only" refusal;
 *  - every other `service` is untouched;
 *  - DELETE stays OPEN, so a tenant row written before this decision can be
 *    cleaned up rather than trapped forever.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AiProviderConnectionEntity, AiProviderConnectionFactory, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT = 'tenant-991';

interface RowSeed {
  tenantId?: string;
  service?: string;
  provider?: string;
  slug?: string;
  enabled?: boolean;
  baseUrl?: string | null;
  extraJson?: unknown;
}

function makeRow(seed: RowSeed = {}): AiProviderConnectionEntity {
  const provider = seed.provider ?? 'openai';
  const slug = seed.slug ?? provider;
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: seed.tenantId ?? TENANT,
    service: seed.service ?? 'embeddings',
    provider,
    slug,
    name: null,
    defaultForProvider: provider,
    enabled: seed.enabled ?? true,
    baseUrl: seed.baseUrl ?? 'https://api.tenant.example/v1',
    extraJson: (seed.extraJson ?? null) as any,
    encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: 3,
  });
}

function makeRepo(rows: AiProviderConnectionEntity[] = []) {
  const live = () => rows.filter((r) => r.resourceStatus !== ResourceStatusType.DELETED);
  const repo: any = {
    rows,
    findByTenantServiceSlug: vi.fn(
      async (service: string, slug: string, tenantId: string) =>
        live().find((r) => r.tenantId === tenantId && r.service === service && r.slug === slug) ?? null,
    ),
    findAllByTenantServiceProvider: vi.fn(async (service: string, provider: string, tenantId: string) =>
      live().filter((r) => r.tenantId === tenantId && r.service === service && r.provider === provider),
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
      live().filter((r) => r.tenantId === tenantId && r.service === service),
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

function makeService(opts: { rows?: AiProviderConnectionEntity[]; roles?: string[] } = {}) {
  const repo = makeRepo(opts.rows ?? []);
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? TENANT : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped', $transaction: vi.fn(async (cb: any) => cb({ $lane: 'tx' })) } };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = {
    isFeatureEnabled: vi.fn(async () => true),
    assertQuantityQuota: vi.fn(async () => undefined),
  };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo, emitter };
}

/** The message a tenant admin must be able to act on. */
const PLATFORM_MANAGED = /platform-managed/i;

describe('TASK-991 OD-3/OD-4 — a tenant may not configure `embeddings`', () => {
  // `CLOUD_BYO_PROVIDERS.embeddings` — every provider a tenant could name. The
  // refusal is about the CAPABILITY, so it cannot be dodged by picking another.
  it.each(['openai', 'azure'])('refuses a tenant-tier CREATE for embeddings:%s', async (provider) => {
    const { svc, repo } = makeService();

    await expect(
      svc.upsertRow('embeddings', provider, { provider, apiKey: 'sk-tenant', baseUrl: 'https://api.tenant.example/v1', expectedVersion: 0 }, TENANT),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.upsertRow('embeddings', provider, { provider, apiKey: 'sk-tenant', expectedVersion: 0 }, TENANT),
    ).rejects.toThrow(PLATFORM_MANAGED);

    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a tenant-tier UPDATE of a row written before the decision', async () => {
    const existing = makeRow({ provider: 'openai' });
    const { svc, repo } = makeService({ rows: [existing] });

    await expect(
      svc.upsertRow('embeddings', 'openai', { extraJson: { model: 'text-embedding-3-large' }, expectedVersion: existing.version }, TENANT),
    ).rejects.toThrow(PLATFORM_MANAGED);

    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('refuses before reading the row, so there is no id space to probe', async () => {
    // The gate is row-INDEPENDENT and provider-INDEPENDENT: every slug in the
    // tenant's own `embeddings` namespace answers identically, existing or not,
    // so running it first leaks nothing (rule 05 §Imperative Privilege Checks).
    const { svc, repo } = makeService();

    await expect(svc.upsertRow('embeddings', 'openai', { provider: 'openai', expectedVersion: 0 }, TENANT)).rejects.toThrow(PLATFORM_MANAGED);

    expect(repo.findByTenantServiceSlug).not.toHaveBeenCalled();
  });

  it('leaves every OTHER capability alone', async () => {
    const { svc, repo } = makeService();

    const res = await svc.upsertRow('llm', 'openai', { provider: 'openai', apiKey: 'sk-tenant', enabled: true, expectedVersion: 0 }, TENANT);

    expect(res.provider).toBe('openai');
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('still lets a tenant DELETE a row written before the decision', async () => {
    // Refusing the cleanup would trap an inert row forever — the tenant can no
    // longer edit it, so it must at least be able to remove it.
    const existing = makeRow({ provider: 'openai' });
    const { svc, repo } = makeService({ rows: [existing] });

    await svc.deleteRow('embeddings', 'openai', TENANT);

    expect(repo.softDelete).toHaveBeenCalledTimes(1);
  });
});

describe('TASK-991 OD-3/OD-4 — the platform tier is unchanged', () => {
  it('lets a SUPER_ADMIN write the SYSTEM embeddings row', async () => {
    const { svc, repo } = makeService({ roles: ['SUPER_ADMIN'] });

    const res = await svc.upsertRow(
      'embeddings',
      'tei-embed',
      { provider: 'tei-embed', baseUrl: 'http://hope-tei-embed:80/v1', extraJson: { model: 'BAAI/bge-m3' }, enabled: true, expectedVersion: 0 },
      SYSTEM_TENANT_ID,
    );

    expect(res.provider).toBe('tei-embed');
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('still refuses a SYSTEM-tier write from a non-super-admin, with the pre-existing message', async () => {
    // The new gate is a TIER gate, not a privilege gate: `assertWriteAllowed`
    // remains the thing that requires SUPER_ADMIN on the SYSTEM tier, and this
    // proves the two did not get conflated.
    const { svc, repo } = makeService({ roles: ['TENANT_ADMIN'] });

    const dto = { provider: 'tei-embed', baseUrl: 'http://hope-tei-embed:80/v1', expectedVersion: 0 };
    await expect(svc.upsertRow('embeddings', 'tei-embed', dto, SYSTEM_TENANT_ID)).rejects.toThrow(/super administrators only/i);

    expect(repo.create).not.toHaveBeenCalled();
  });
});
