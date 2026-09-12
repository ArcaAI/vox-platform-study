/**
 * TASK-958 review fixes (lane G1) — the three service-side defects the
 * correctness and security reviews found on the merged multiplicity work.
 *
 * Each `describe` quotes the reviewer's own scenario, because the value of
 * these tests is that they refuse to pass for the reason the bug existed:
 *
 *   F1 (correctness #1) — `deleteRow` soft-deletes a DEFAULT but leaves
 *       `defaultForProvider = provider` on the tombstone. The unique index
 *       `AiProviderConnection_tenant_service_default_key` is NOT partial and
 *       knows nothing of soft delete, so the dead row keeps holding the
 *       provider's default SLOT: every subsequent slug for that provider is
 *       wedged behind a raw Postgres unique violation until the exact original
 *       slug is revived.
 *   F2 (security, HIGH — write half) — `resolveProviderForWrite` accepts
 *       `PUT tts/azure {provider:'sarvam'}`, minting a row whose SLUG is
 *       another vendor's id. `connection_key` on the TTS/STT wire is that slug,
 *       so the row aliases the platform `azure` key.
 *   F4 (correctness #7) — reading an unsaved sibling slug 404s with a message
 *       calling the slug a "provider".
 *
 * THE FIXTURE MODELS BOTH UNIQUE INDEXES OVER LIVE **AND** DELETED ROWS. That
 * is the whole point of F1: an in-memory repository that only ever looks at
 * live rows cannot fail the way Postgres does, and a test written against such
 * a fixture would have passed on the broken code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { AiProviderConnectionEntity, AiProviderConnectionFactory, ResourceStatusType } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { CONNECTION_ERROR_CODES } from '../constants';

const TENANT = 'tenant-958-g1';

interface RowSeed {
  service?: string;
  provider?: string;
  slug?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

function makeRow(seed: RowSeed = {}): AiProviderConnectionEntity {
  const provider = seed.provider ?? 'openai';
  const slug = seed.slug ?? provider;
  const isDefault = seed.isDefault ?? slug === provider;
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: TENANT,
    service: seed.service ?? 'llm',
    provider,
    slug,
    name: null,
    defaultForProvider: isDefault ? provider : null,
    enabled: seed.enabled ?? false,
    encryptedApiKey: null,
    keyVersion: null,
  });
}

/** The unique-violation Postgres raises; shaped like Prisma's P2002 so the assertion reads true. */
class UniqueViolation extends Error {
  code = 'P2002';
  constructor(index: string) {
    super(`Unique constraint failed on the constraint: \`${index}\``);
  }
}

/**
 * An in-memory repository that enforces the TWO unique indexes the migration
 * declares — ACROSS TOMBSTONES, exactly as Postgres does:
 *   `(tenantId, service, slug)` and `(tenantId, service, defaultForProvider)`
 *   (NULLs distinct, so any number of non-default rows coexist).
 * Reads stay live-only, which is what the soft-delete extension does.
 */
function makeRepo(rows: AiProviderConnectionEntity[] = []) {
  const live = () => rows.filter((r) => r.resourceStatus !== ResourceStatusType.DELETED);

  const assertIndexes = (subject: AiProviderConnectionEntity): void => {
    for (const other of rows) {
      if (other.id === subject.id) continue;
      if (other.tenantId !== subject.tenantId || other.service !== subject.service) continue;
      if (other.slug === subject.slug) throw new UniqueViolation('AiProviderConnection_tenant_service_slug_key');
      if (subject.defaultForProvider != null && other.defaultForProvider === subject.defaultForProvider) {
        throw new UniqueViolation('AiProviderConnection_tenant_service_default_key');
      }
    }
  };

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
    findDeletedByTenantServiceSlug: vi.fn(
      async (service: string, slug: string, tenantId: string) =>
        rows.find((r) => r.resourceStatus === ResourceStatusType.DELETED && r.tenantId === tenantId && r.service === service && r.slug === slug) ??
        null,
    ),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      live().filter((r) => r.tenantId === tenantId && r.service === service),
    ),
    create: vi.fn(async (entity: AiProviderConnectionEntity) => {
      assertIndexes(entity);
      rows.push(entity);
      return entity;
    }),
    update: vi.fn(async (_id: string, entity: AiProviderConnectionEntity) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: AiProviderConnectionEntity) => {
      assertIndexes(entity);
      (entity as any)._version = entity.version + 1;
      return entity;
    }),
    softDelete: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) (row as any)._resourceStatus = ResourceStatusType.DELETED;
      return row;
    }),
  };
  return repo;
}

function makeService(rows: AiProviderConnectionEntity[] = []) {
  const repo = makeRepo(rows);
  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: [] } : k === 'tenantId' ? TENANT : undefined)) };
  const db = { baseClient: { $lane: 'unscoped', $transaction: vi.fn(async (cb: any) => cb({ $lane: 'tx' })) } };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => true), assertQuantityQuota: vi.fn(async () => undefined) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo, db };
}

// ===========================================================================
// F1 — "a soft-deleted DEFAULT wedges its provider"
// ===========================================================================

describe('TASK-958/G1 F1 — a soft-deleted DEFAULT must not keep holding the provider’s default slot', () => {
  it('clears `defaultForProvider` on the tombstone when the default is deleted', async () => {
    const def = makeRow({ provider: 'openai' });
    const { svc } = makeService([def]);

    await svc.deleteRow('llm', 'openai', TENANT);

    expect(def.resourceStatus).toBe(ResourceStatusType.DELETED);
    expect(def.defaultForProvider ?? null, 'the tombstone still occupies (tenant, service, defaultForProvider)').toBeNull();
  });

  it('reviewer #1: delete the only `llm/openai` row, then `PUT llm/openai-research {provider:"openai"}` with If-Match "0" — the new slug becomes the default instead of a P2002', async () => {
    const def = makeRow({ provider: 'openai' });
    const { svc } = makeService([def]);

    await svc.deleteRow('llm', 'openai', TENANT);
    const created = await svc.upsertRow('llm', 'openai-research', { provider: 'openai', name: 'Research', expectedVersion: 0 }, TENANT);

    expect(created.slug).toBe('openai-research');
    expect(created.isDefault, 'the provider has no other live row, so the new one takes the default job').toBe(true);
  });

  it('reviving the deleted slug while another default lives makes it a SIBLING, never a second default', async () => {
    const def = makeRow({ provider: 'openai' });
    const { svc } = makeService([def]);

    await svc.deleteRow('llm', 'openai', TENANT);
    const elected = await svc.upsertRow('llm', 'openai-research', { provider: 'openai', expectedVersion: 0 }, TENANT);
    expect(elected.isDefault).toBe(true);

    const revived = await svc.upsertRow('llm', 'openai', { provider: 'openai', expectedVersion: 0 }, TENANT);
    expect(revived.slug).toBe('openai');
    expect(revived.isDefault, 'a revive re-elects per `resolveDefaultIntent`; a live default already exists').toBe(false);

    const list = await svc.list('llm', TENANT);
    expect(list.filter((r) => r.isDefault).map((r) => r.slug)).toEqual(['openai-research']);
  });

  it('a revive still TAKES the default when the provider has none (the tombstone’s own marker is not what decides)', async () => {
    const def = makeRow({ provider: 'openai' });
    const { svc } = makeService([def]);

    await svc.deleteRow('llm', 'openai', TENANT);
    const revived = await svc.upsertRow('llm', 'openai', { provider: 'openai', expectedVersion: 0 }, TENANT);

    expect(revived.isDefault).toBe(true);
  });
});

// ===========================================================================
// F2 — "a tenant slug may impersonate another provider's id"
// ===========================================================================

describe('TASK-958/G1 F2 — a connection slug may not impersonate a provider id or a route segment', () => {
  it('security review: `PUT tts/azure {provider:"sarvam"}` is refused — the row would alias the platform `azure` key on the wire', async () => {
    const { svc } = makeService();

    await expect(svc.upsertRow('tts', 'azure', { provider: 'sarvam', apiKey: 'k', expectedVersion: 0 }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.SLUG_RESERVED, slug: 'azure' },
    });
  });

  it('refuses a slug that is a provider id of ANOTHER service (`azure-speech` is an stt vendor)', async () => {
    const { svc } = makeService();

    await expect(svc.upsertRow('tts', 'azure-speech', { provider: 'azure', apiKey: 'k', expectedVersion: 0 }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.SLUG_RESERVED },
    });
  });

  it('refuses `platform-defaults`, which is a route segment declared before `:slug`', async () => {
    const { svc } = makeService();

    await expect(svc.upsertRow('llm', 'platform-defaults', { provider: 'openai', apiKey: 'k', expectedVersion: 0 }, TENANT)).rejects.toMatchObject({
      response: { code: CONNECTION_ERROR_CODES.SLUG_RESERVED, reason: 'route-segment' },
    });
  });

  it('a legitimate named sibling still creates (the refusal is about impersonation, not about naming)', async () => {
    const { svc } = makeService([makeRow({ service: 'tts', provider: 'azure' })]);

    const created = await svc.upsertRow('tts', 'azure-research', { provider: 'azure', apiKey: 'k', expectedVersion: 0 }, TENANT);
    expect(created).toMatchObject({ slug: 'azure-research', provider: 'azure', isDefault: false });
  });

  it('the pre-958 shape — slug IS the provider — is untouched', async () => {
    const { svc } = makeService();

    const created = await svc.upsertRow('llm', 'openai', { apiKey: 'k', expectedVersion: 0 }, TENANT);
    expect(created).toMatchObject({ slug: 'openai', provider: 'openai', isDefault: true });
  });
});

// ===========================================================================
// F4 — the 404 message for an unsaved sibling
// ===========================================================================

describe('TASK-958/G1 F4 — reading an unsaved sibling slug names the CONNECTION, not a provider', () => {
  it('correctness #7: `GET llm/openai-research` on a tenant that never saved it says "connection", never "provider"', async () => {
    const { svc } = makeService();

    await expect(svc.getRow('llm', 'openai-research', TENANT)).rejects.toMatchObject({
      message: expect.stringContaining('connection'),
    });
    await expect(svc.getRow('llm', 'openai-research', TENANT)).rejects.not.toMatchObject({
      message: expect.stringContaining("provider 'openai-research'"),
    });
  });

  it('a platform-managed provider still hides behind the provider-shaped 404 (nothing about it is disclosed)', async () => {
    const { svc } = makeService();

    await expect(svc.getRow('llm', 'lm-studio', TENANT)).rejects.toMatchObject({
      message: expect.stringContaining("provider 'lm-studio'"),
    });
  });
});
