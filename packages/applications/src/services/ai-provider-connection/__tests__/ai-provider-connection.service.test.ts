/**
 * AiProviderConnectionService — unit tests (tests 1–5).
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

function makeService(opts: { roles?: string[]; clsTenantId?: string | null; withVault?: boolean; entitled?: boolean } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findDeletedByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets =
    opts.withVault === false
      ? undefined
      : {
          encrypt: vi.fn(async () => 'vault:v3:cipher'),
          decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
          supportsTransit: vi.fn(() => true),
        };
  // The platform-default entitlement gate. Defaults to GRANTED here
  // so these pre-existing cascade cases keep testing the cascade rather than
  // the gate (which `ai-provider-connection.platform-default-gate.test.ts`
  // owns); pass `entitled: false` to exercise a denial.
  const entitlements = { isFeatureEnabled: vi.fn(async () => opts.entitled ?? true) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo, emitter, cls, secrets, entitlements };
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

describe('AiProviderConnectionService — tenant lane (tests 1–2)', () => {
  it('rejects a tenant-scoped row for a self-host provider with 403, not 404', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('llm', 'ollama', { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['lm-studio', 'vllm', 'llama-cpp', 'built-in'])('rejects a tenant-scoped row for self-host provider %s', async (provider) => {
    const { svc } = makeService();
    await expect(svc.upsertRow('llm', provider, { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['azure', 'bedrock'])('allows a tenant-scoped row for cloud provider %s', async (provider) => {
    const { svc, repo } = makeService();
    const res = await svc.upsertRow('llm', provider, { enabled: true }, TENANT);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe(provider);
  });

  it('builds the entity through the factory (never `new`), stamping a uuid id', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow('llm', 'azure', { enabled: true }, TENANT);
    const created = repo.create.mock.calls[0][0];
    expect(created.constructor.name).toBe('AiProviderConnectionEntity');
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
  });
});

// ===========================================================================
// 3. Secret containment
// ===========================================================================

describe('AiProviderConnectionService — secret containment (test 3)', () => {
  it('exposes hasKey but never the ciphertext, at any depth of the read DTO', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow({ encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'), keyVersion: 3 }));

    const res = await svc.getRow('llm', 'azure', TENANT);

    expect(res.hasKey).toBe(true);
    const keys = deepKeys(res);
    expect(keys).not.toContain('encryptedApiKey');
    expect(keys).not.toContain('apiKey');
    // A stringified round-trip must not carry the ciphertext bytes either.
    expect(JSON.stringify(res)).not.toContain('cipher');
  });

  it('reports hasKey false when no key material is present', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow({ encryptedApiKey: null, keyVersion: null }));
    const res = await svc.getRow('llm', 'azure', TENANT);
    expect(res.hasKey).toBe(false);
  });

  it('keeps the ciphertext out of the LIST DTO too', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantIdAndService.mockResolvedValue([makeRow({ encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'), keyVersion: 3 })]);
    const res = await svc.list('llm', TENANT);
    expect(deepKeys(res)).not.toContain('encryptedApiKey');
    expect(JSON.stringify(res)).not.toContain('cipher');
  });

  it('encrypts a supplied apiKey through the Vault util and stores only ciphertext', async () => {
    const { svc, repo, secrets } = makeService();
    await svc.upsertRow('llm', 'azure', { enabled: true, apiKey: 'sk-live-secret' }, TENANT);
    expect(secrets!.encrypt).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0][0];
    expect(created.encryptedApiKey).not.toBeNull();
    expect(Buffer.from(created.encryptedApiKey!).toString('utf8')).toBe('vault:v3:cipher');
    // parseKeyVersionFromCiphertext('vault:v3:cipher') === 3
    expect(created.keyVersion).toBe(3);
  });

  it('refuses to write a key when Vault is not configured (no plaintext-at-rest fallback)', async () => {
    const { svc } = makeService({ withVault: false });
    await expect(svc.upsertRow('llm', 'azure', { enabled: true, apiKey: 'sk-live' }, TENANT)).rejects.toThrow(/Vault/i);
  });

  it('refuses with 400 (not 503) when SecretsService IS injected but the configured provider has no Transit support (SECRETS_PROVIDER=env/aws/azure/in-memory)', async () => {
    // The realistic non-vault shape: SecretsService is unconditionally provided
    // by the module (unlike `withVault: false` above, which models the
    // theoretical "no DI provider at all" case), but `supportsTransit()`
    // reports false because the configured provider has no Transit engine.
    // Regression for a bug where this fell through to `.encrypt()`'s
    // capability-guard `Error` and was misreported as a transient 503.
    const { svc, secrets } = makeService();
    (secrets!.supportsTransit as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(svc.upsertRow('llm', 'azure', { enabled: true, apiKey: 'sk-live' }, TENANT)).rejects.toThrow(/Vault/i);
    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  // ── Precondition verdicts come BEFORE any Vault call ────

  it('a stale expectedVersion on an ABSENT row 412s without ever calling Transit (even with an apiKey in the body)', async () => {
    const { svc, secrets } = makeService();
    await expect(svc.upsertRow('llm', 'azure', { apiKey: 'probe-key', expectedVersion: 9999 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('expectedVersion 0 (create-intent) against an EXISTING row at version >= 1 is STALE → 412', async () => {
    // With `If-Match: "0"` accepted by the gateway parser (G2
    // decision), the service CAS is the line of defense: 0 only means
    // "create" when no row exists; against a materialized row it is drift.
    const { svc, repo } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow()); // factory rows start at version 1
    await expect(svc.upsertRow('llm', 'azure', { enabled: false, expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('a stale expectedVersion on an EXISTING row 412s without calling Transit', async () => {
    const { svc, repo, secrets } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow());
    await expect(svc.upsertRow('llm', 'azure', { apiKey: 'probe-key', expectedVersion: 9999 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(secrets!.encrypt).not.toHaveBeenCalled();
  });

  it('a Transit failure surfaces as 503 ServiceUnavailable, not a raw 500', async () => {
    const { svc, secrets } = makeService();
    (secrets!.encrypt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Transit is not supported by this provider'));
    await expect(svc.upsertRow('llm', 'azure', { apiKey: 'probe-key', expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // ── F-028: restore-with-overwrite over a soft-deleted tombstone ──────────

  it('create-intent (If-Match "0") over a soft-DELETED row RESTORES and overwrites it instead of 409ing', async () => {
    const { svc, repo, emitter } = makeService();
    const deletedRow = makeRow({ baseUrl: 'https://stale.example', enabled: false });
    deletedRow.delete(); // resourceStatus -> DELETED (mirrors repository.softDelete's terminal state)
    repo.findDeletedByTenantServiceProvider.mockResolvedValue(deletedRow);

    const res = await svc.upsertRow('llm', 'azure', { baseUrl: 'https://revived.example', enabled: true, expectedVersion: 0 }, TENANT);

    // Restored via CAS against the tombstone's OWN version, never a plain insert.
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    const [restoredId, restoredEntity, expectedVersionArg] = repo.updateWithVersion.mock.calls[0];
    expect(restoredId).toBe(deletedRow.id);
    expect(expectedVersionArg).toBe(deletedRow.version);
    expect(restoredEntity.resourceStatus).toBe('ENABLED');

    expect(res.baseUrl).toBe('https://revived.example');
    expect(res.enabled).toBe(true);
    expect(emitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'connection-restored' }) }),
    );
  });

  it('restore-with-overwrite clears stale key material when the revive omits apiKey', async () => {
    const { svc, repo } = makeService();
    const deletedRow = makeRow({ encryptedApiKey: Buffer.from('vault:v3:old-cipher', 'utf8'), keyVersion: 3 });
    deletedRow.delete();
    repo.findDeletedByTenantServiceProvider.mockResolvedValue(deletedRow);

    const res = await svc.upsertRow('llm', 'azure', { enabled: true, expectedVersion: 0 }, TENANT);
    // Must actually go through the restore lane (not merely coincide with a
    // plain create that also happens to omit the key).
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(res.hasKey).toBe(false);
  });

  it('a live (non-deleted) row still 412s on create-intent — the restore lane never masks the normal OCC contract', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow()); // a LIVE row exists
    await expect(svc.upsertRow('llm', 'azure', { enabled: false, expectedVersion: 0 }, TENANT)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    expect(repo.findDeletedByTenantServiceProvider).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. SYSTEM-row governance + sys-events
// ===========================================================================

describe('AiProviderConnectionService — SYSTEM governance (test 4)', () => {
  it('rejects a SYSTEM-row write from a non-global-admin with 403', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.upsertRow('llm', 'ollama', { enabled: true }, SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a SYSTEM-row write from a global admin, for a self-host provider', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    const res = await svc.upsertRow('llm', 'ollama', { enabled: true, baseUrl: 'http://localhost:11434' }, SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.provider).toBe('ollama');
  });

  it('broadcasts ResourceCreated on create', async () => {
    const { svc, emitter } = makeService();
    await svc.upsertRow('llm', 'azure', { enabled: true }, TENANT);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('broadcasts ResourceUpdated on update', async () => {
    const { svc, repo, emitter } = makeService();
    const existing = makeRow({ enabled: false });
    repo.findByTenantServiceProvider.mockResolvedValue(existing);
    await svc.upsertRow('llm', 'azure', { enabled: true, expectedVersion: existing.version }, TENANT);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
  });

  it('broadcasts ResourceDeleted on delete', async () => {
    const { svc, repo, emitter } = makeService();
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow());
    await svc.deleteRow('llm', 'azure', TENANT);
    expect(repo.softDelete).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
  });
});

// ===========================================================================
// 5. Resolution cascade
// ===========================================================================

describe('AiProviderConnectionService — resolveConnection cascade (test 5)', () => {
  it('prefers an ENABLED tenant row over the SYSTEM row', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockImplementation(async (_service: string, _provider: string, tenantId: string) =>
      tenantId === TENANT
        ? makeRow({ tenantId: TENANT, enabled: true, baseUrl: 'https://tenant.example' })
        : makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: true, baseUrl: 'https://system.example' }),
    );

    const resolved = await svc.resolveConnection('llm', 'azure', TENANT);
    expect(resolved?.baseUrl).toBe('https://tenant.example');
    expect(resolved?.source).toBe('tenant');
  });

  it('falls through an ABSENT tenant row to the SYSTEM row', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockImplementation(async (_service: string, _provider: string, tenantId: string) =>
      tenantId === TENANT ? null : makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: true, baseUrl: 'https://system.example' }),
    );

    const resolved = await svc.resolveConnection('llm', 'azure', TENANT);
    expect(resolved?.baseUrl).toBe('https://system.example');
    expect(resolved?.source).toBe('system');
  });

  it('does NOT fall through a DISABLED tenant row — makes that a VETO', async () => {
    // CONTRACT CHANGE, deliberate: this case used to resolve the SYSTEM row.
    // A disabled tenant row is now the tenant REFUSING that provider (a shared
    // vendor account is a PHI decision), so it fails closed instead of quietly
    // routing the call onto the platform's key. `resolveConnection` had zero
    // production callers when this flipped, so nothing observable changed with
    // it — but the rule must match the injection resolver's, or the two paths
    // would disagree about the same row.
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockImplementation(async (_service: string, _provider: string, tenantId: string) =>
      tenantId === TENANT
        ? makeRow({ tenantId: TENANT, enabled: false, baseUrl: 'https://tenant.example' })
        : makeRow({ tenantId: SYSTEM_TENANT_ID, enabled: true, baseUrl: 'https://system.example' }),
    );

    await expect(svc.resolveConnection('llm', 'azure', TENANT)).resolves.toBeNull();
  });

  it('falls through a DISABLED SYSTEM row to null (the env-fallback signal)', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockResolvedValue(makeRow({ enabled: false }));
    await expect(svc.resolveConnection('llm', 'azure', TENANT)).resolves.toBeNull();
  });

  it('returns null when no row exists at all', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockResolvedValue(null);
    await expect(svc.resolveConnection('llm', 'azure', TENANT)).resolves.toBeNull();
  });
});
