/**
 * AiProviderConnectionService (TASK-524) — unit tests (§5 tests 1–5).
 *
 * Mirrors the `ai-task-default` / `tenant-tts-config` test style: repositories,
 * EventEmitter2, ClsService and the Vault SecretsService are mocked.
 *
 * The four contracts locked here:
 *   1. The tenant-lane rule — a tenant may hold a BYO row ONLY for a cloud API
 *      provider (azure/bedrock). A self-host provider is a PRIVILEGE boundary
 *      on the caller's own tenant → 403, deliberately NOT the 404-over-403
 *      cross-tenant posture.
 *   2. SYSTEM-row writes require a global admin → 403.
 *   3. No read DTO anywhere carries `encryptedApiKey`/ciphertext — asserted by
 *      a recursive deep-key scan, not a shallow property check.
 *   4. `resolveConnection` cascades enabled-tenant → SYSTEM → null, where null
 *      is the "fall through to the service env" signal.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const TENANT = 'tenant-abc';

function makeRow(
  overrides: {
    tenantId?: string;
    provider?: string;
    enabled?: boolean;
    baseUrl?: string | null;
    encryptedApiKey?: Uint8Array | null;
    keyVersion?: number | null;
  } = {},
) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: overrides.tenantId ?? TENANT,
    provider: overrides.provider ?? 'azure',
    baseUrl: overrides.baseUrl ?? null,
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.encryptedApiKey ?? null,
    keyVersion: overrides.keyVersion ?? null,
  });
}

function makeService(opts: { roles?: string[]; clsTenantId?: string | null; withVault?: boolean } = {}) {
  const repo = {
    findByTenantAndProvider: vi.fn().mockResolvedValue(null),
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) =>
      k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined,
    ),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets =
    opts.withVault === false
      ? undefined
      : {
          encrypt: vi.fn(async () => 'vault:v3:cipher'),
          decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
        };
  const svc = new AiProviderConnectionService(
    repo as any,
    db as any,
    emitter as any,
    cls as any,
    secrets as any,
  );
  return { svc, repo, emitter, cls, secrets };
}

/** Recursively collect every key name in an object graph. */
function deepKeys(value: unknown, acc: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    value.forEach((v) => deepKeys(v, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    acc.push(k);
    deepKeys(v, acc);
  }
  return acc;
}

// ===========================================================================
// 1 + 2. The tenant-lane rule
// ===========================================================================

describe('AiProviderConnectionService — tenant lane (§5 tests 1–2)', () => {
  it('rejects a tenant-scoped row for a self-host provider with 403, not 404', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('ollama', { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['lm-studio', 'vllm', 'llama-cpp', 'built-in'])(
    'rejects a tenant-scoped row for self-host provider %s',
    async (provider) => {
      const { svc } = makeService();
      await expect(svc.upsertRow(provider, { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each(['azure', 'bedrock'])('allows a tenant-scoped row for cloud provider %s', async (provider) => {
    const { svc, repo } = makeService();
    const res = await svc.upsertRow(provider, { enabled: true }, TENANT);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe(provider);
  });

  it('builds the entity through the factory (never `new`), stamping a uuid id', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow('azure', { enabled: true }, TENANT);
    const created = repo.create.mock.calls[0][0];
    expect(created.constructor.name).toBe('AiProviderConnectionEntity');
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
  });
});

// ===========================================================================
// 3. Secret containment
// ===========================================================================

describe('AiProviderConnectionService — secret containment (§5 test 3)', () => {
  it('exposes hasKey but never the ciphertext, at any depth of the read DTO', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantAndProvider.mockResolvedValue(
      makeRow({ encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'), keyVersion: 3 }),
    );

    const res = await svc.getRow('azure', TENANT);

    expect(res.hasKey).toBe(true);
    const keys = deepKeys(res);
    expect(keys).not.toContain('encryptedApiKey');
    expect(keys).not.toContain('apiKey');
    // A stringified round-trip must not carry the ciphertext bytes either.
    expect(JSON.stringify(res)).not.toContain('cipher');
  });

  it('reports hasKey false when no key material is present', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantAndProvider.mockResolvedValue(makeRow({ encryptedApiKey: null, keyVersion: null }));
    const res = await svc.getRow('azure', TENANT);
    expect(res.hasKey).toBe(false);
  });

  it('keeps the ciphertext out of the LIST DTO too', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantId.mockResolvedValue([
      makeRow({ encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'), keyVersion: 3 }),
    ]);
    const res = await svc.list(TENANT);
    expect(deepKeys(res)).not.toContain('encryptedApiKey');
    expect(JSON.stringify(res)).not.toContain('cipher');
  });

  it('encrypts a supplied apiKey through the Vault util and stores only ciphertext', async () => {
    const { svc, repo, secrets } = makeService();
    await svc.upsertRow('azure', { enabled: true, apiKey: 'sk-live-secret' }, TENANT);
    expect(secrets!.encrypt).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0][0];
    expect(created.encryptedApiKey).not.toBeNull();
    expect(Buffer.from(created.encryptedApiKey!).toString('utf8')).toBe('vault:v3:cipher');
    // parseKeyVersionFromCiphertext('vault:v3:cipher') === 3
    expect(created.keyVersion).toBe(3);
  });

  it('refuses to write a key when Vault is not configured (no plaintext-at-rest fallback)', async () => {
    const { svc } = makeService({ withVault: false });
    await expect(svc.upsertRow('azure', { enabled: true, apiKey: 'sk-live' }, TENANT)).rejects.toThrow(/Vault/i);
  });

  // ── TASK-534 e2e G3 — precondition verdicts come BEFORE any Vault call ────

  it('G3: a stale expectedVersion on an ABSENT row 412s without ever calling Transit (even with an apiKey in the body)', async () => {
    const { svc, secrets } = makeService();
    await expect(svc.upsertRow('azure', { apiKey: 'probe-key', expectedVersion: 9999 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('G2: expectedVersion 0 (create-intent) against an EXISTING row at version >= 1 is STALE → 412', async () => {
    // With `If-Match: "0"` now accepted by the gateway parser (TASK-534 G2
    // owner decision), the service CAS is the line of defense: 0 only means
    // "create" when no row exists; against a materialized row it is drift.
    const { svc, repo } = makeService();
    repo.findByTenantAndProvider.mockResolvedValue(makeRow()); // factory rows start at version 1
    await expect(svc.upsertRow('azure', { enabled: false, expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('G3: a stale expectedVersion on an EXISTING row 412s without calling Transit', async () => {
    const { svc, repo, secrets } = makeService();
    repo.findByTenantAndProvider.mockResolvedValue(makeRow());
    await expect(svc.upsertRow('azure', { apiKey: 'probe-key', expectedVersion: 9999 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('G3: a Transit failure surfaces as 503 ServiceUnavailable, not a raw 500', async () => {
    const { svc, secrets } = makeService();
    (secrets!.encrypt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Transit is not supported by this provider'));
    await expect(svc.upsertRow('azure', { apiKey: 'probe-key', expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

// ===========================================================================
// 4. SYSTEM-row governance + sys-events
// ===========================================================================

describe('AiProviderConnectionService — SYSTEM governance (§5 test 4)', () => {
  it('rejects a SYSTEM-row write from a non-global-admin with 403', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.upsertRow('ollama', { enabled: true }, SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a SYSTEM-row write from a global admin, for a self-host provider', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    const res = await svc.upsertRow('ollama', { enabled: true, baseUrl: 'http://localhost:11434' }, SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe('ollama');
  });

  it('broadcasts ResourceCreated on create', async () => {
    const { svc, emitter } = makeService();
    await svc.upsertRow('azure', { enabled: true }, TENANT);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('broadcasts ResourceUpdated on update', async () => {
    const { svc, repo, emitter } = makeService();
    const existing = makeRow({ enabled: false });
    repo.findByTenantAndProvider.mockResolvedValue(existing);
    await svc.upsertRow('azure', { enabled: true, expectedVersion: existing.version }, TENANT);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
  });

  it('broadcasts ResourceDeleted on delete', async () => {
    const { svc, repo, emitter } = makeService();
    repo.findByTenantAndProvider.mockResolvedValue(makeRow());
    await svc.deleteRow('azure', TENANT);
    expect(repo.softDelete).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
  });
});

// ===========================================================================
// 5. Resolution cascade
// ===========================================================================

describe('AiProviderConnectionService — resolveConnection cascade (§5 test 5)', () => {
  it('prefers an ENABLED tenant row over the SYSTEM row', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantAndProvider.mockImplementation(async (tenantId: string) =>
      tenantId === TENANT
        ? makeRow({ tenantId: TENANT, enabled: true, baseUrl: 'https://tenant.example' })
        : makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: true, baseUrl: 'https://system.example' }),
    );

    const resolved = await svc.resolveConnection('azure', TENANT);
    expect(resolved?.baseUrl).toBe('https://tenant.example');
    expect(resolved?.source).toBe('tenant');
  });

  it('falls through a DISABLED tenant row to the SYSTEM row', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantAndProvider.mockImplementation(async (tenantId: string) =>
      tenantId === TENANT
        ? makeRow({ tenantId: TENANT, enabled: false, baseUrl: 'https://tenant.example' })
        : makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: true, baseUrl: 'https://system.example' }),
    );

    const resolved = await svc.resolveConnection('azure', TENANT);
    expect(resolved?.baseUrl).toBe('https://system.example');
    expect(resolved?.source).toBe('system');
  });

  it('falls through a DISABLED SYSTEM row to null (the env-fallback signal)', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantAndProvider.mockResolvedValue(makeRow({ enabled: false }));
    await expect(svc.resolveConnection('azure', TENANT)).resolves.toBeNull();
  });

  it('returns null when no row exists at all', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantAndProvider.mockResolvedValue(null);
    await expect(svc.resolveConnection('azure', TENANT)).resolves.toBeNull();
  });
});
