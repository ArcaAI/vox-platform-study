// TASK-302 Phase 5 Task 5.6 (Stream B) — VaultPrismaFactoryModule.
//
// Unit tests for the pure builder. Spins up no Nest DI; asserts the
// env-toggle branching directly. The downstream VaultPrismaClient is
// stubbed via vi.mock so we don't open real PG connections.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const vaultPrismaCreate = vi.fn();

vi.mock('@arcaai/database', () => ({
  applySoftDeleteExtension: vi.fn((client) => ({ __soft: client })),
  applyTenantScopeExtension: vi.fn((client, options) => ({ __tenant: client, __options: options })),
  resolveTenantContext: vi.fn(() => ({ tenantId: 'tenant-from-cls', isSuperAdmin: false })),
  VaultPrismaClient: {
    create: vaultPrismaCreate,
  },
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vaultPrismaCreate.mockReset();
  process.env = { ...originalEnv };
});

afterEach(() => {
  vi.useRealTimers();
  process.env = originalEnv;
});

describe('buildVaultPrismaFactory env-toggle gating', () => {
  it('returns null when SECRETS_PROVIDER is not vault', async () => {
    process.env.SECRETS_PROVIDER = 'env';
    process.env.PG_DYNAMIC_CREDS = 'true';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const fakeSecrets = { requestDbCredential: vi.fn() } as never;
    expect(buildVaultPrismaFactory(fakeSecrets)).toBeNull();
  });

  it('returns null when PG_DYNAMIC_CREDS is not "true"', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'false';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    expect(buildVaultPrismaFactory({} as never)).toBeNull();
  });

  it('returns null when PG_DYNAMIC_CREDS is unset', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    delete process.env.PG_DYNAMIC_CREDS;
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    expect(buildVaultPrismaFactory({} as never)).toBeNull();
  });

  it('returns a callable factory when both toggles are on', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory({} as never);
    expect(factory).toBeInstanceOf(Function);
  });

  it('factory invocation creates VaultPrismaClient with the configured role and returns {client, extendedClient, disconnect}', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    process.env.PG_VAULT_ROLE = 'hope-app-role';

    const disconnectMock = vi.fn(async () => undefined);
    const fakeClient = { $queryRaw: vi.fn() };
    vaultPrismaCreate.mockResolvedValueOnce({
      client: fakeClient,
      disconnect: disconnectMock,
      leaseId: 'lid-1',
      ttlSec: 3600,
      swap: vi.fn(async () => undefined),
    });

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const fakeSecrets = { requestDbCredential: vi.fn() } as never;
    const factory = buildVaultPrismaFactory(fakeSecrets)!;
    expect(factory).not.toBeNull();
    const result = await factory();

    expect(vaultPrismaCreate).toHaveBeenCalledTimes(1);
    expect(vaultPrismaCreate).toHaveBeenCalledWith(fakeSecrets, 'hope-app-role');
    expect(result.client).toBe(fakeClient);
    // extendedClient composes soft-delete THEN tenant-scope (tenant-scope
    // applied last so its handlers run first) — mirrors env-mode
    // createExtendedPrismaClient. See the tenant-scope regression test below.
    expect(result.extendedClient).toEqual({
      __tenant: { __soft: fakeClient },
      __options: expect.objectContaining({
        getTenantId: expect.any(Function),
        isSuperAdmin: expect.any(Function),
      }),
    });
    expect(typeof result.disconnect).toBe('function');

    await result.disconnect();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  // TASK-444 — regression for the cross-tenant leak: the Vault-mode
  // extendedClient MUST compose tenant-scope on top of soft-delete, exactly
  // like env-mode createExtendedPrismaClient. Without it, tenant-scoped reads
  // that rely on the $extends (e.g. UserRoleAssignmentService.fetchAllByRoleId)
  // run UNSCOPED and leak other tenants' rows.
  it('composes the tenant-scope extension over soft-delete, wired to resolveTenantContext', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';

    const fakeClient = { $queryRaw: vi.fn() };
    vaultPrismaCreate.mockResolvedValueOnce({
      client: fakeClient,
      disconnect: vi.fn(async () => undefined),
      leaseId: 'lid-1',
      ttlSec: 3600,
      swap: vi.fn(async () => undefined),
    });

    const db = await import('@arcaai/database');
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory({} as never)!;
    await factory();

    // soft-delete wraps the raw client, tenant-scope wraps the soft-deleted one
    expect(db.applySoftDeleteExtension).toHaveBeenCalledWith(fakeClient);
    expect(db.applyTenantScopeExtension).toHaveBeenCalledTimes(1);
    const [scopedInput, options] = (db.applyTenantScopeExtension as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(scopedInput).toEqual({ __soft: fakeClient });

    // the options must read tenant context from resolveTenantContext (CLS)
    expect(options.getTenantId()).toBe('tenant-from-cls');
    expect(options.isSuperAdmin()).toBe(false);
  });

  it('honors PG_VAULT_ROLE env override for the role argument', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    process.env.PG_VAULT_ROLE = 'custom-role-name';

    const disconnectMock = vi.fn(async () => undefined);
    vaultPrismaCreate.mockResolvedValueOnce({
      client: {},
      disconnect: disconnectMock,
      leaseId: 'lid-1',
      ttlSec: 3600,
      swap: vi.fn(async () => undefined),
    });

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory({} as never)!;
    await factory();

    expect(vaultPrismaCreate).toHaveBeenCalledWith({}, 'custom-role-name');
  });
});

// BUG-006 — the lease-renewal machinery (VaultLeaseRenewer, swap()) existed
// but nothing in this factory ever started it, so dynamic PG creds went
// stale at lease expiry (~1h) with no reconnect. These tests pin down the
// wiring: renew before expiry while under max_ttl, fall back to swap() on
// renew failure or once max_ttl is close, and register/deregister with
// SecretsService so health() reflects renewer state.
describe('buildVaultPrismaFactory — Vault DB-lease renewal (BUG-006)', () => {
  function fakeWrapper(overrides: Record<string, unknown> = {}) {
    return {
      client: { $queryRaw: vi.fn() },
      disconnect: vi.fn(async () => undefined),
      leaseId: 'database/creds/hope-app-role/lid-1',
      ttlSec: 100,
      swap: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('starts a VaultLeaseRenewer at 50% TTL, calls secrets.renewDbLease, and registers it via secrets.setLeaseRenewer', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';

    const wrapper = fakeWrapper();
    vaultPrismaCreate.mockResolvedValueOnce(wrapper);

    const renewDbLease = vi.fn(async () => ({ ttlSec: 100 }));
    const setLeaseRenewer = vi.fn();
    const clearLeaseRenewer = vi.fn();
    const secrets = { requestDbCredential: vi.fn(), renewDbLease, setLeaseRenewer, clearLeaseRenewer } as never;

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory(secrets)!;
    const result = await factory();

    expect(setLeaseRenewer).toHaveBeenCalledTimes(1);
    expect(renewDbLease).not.toHaveBeenCalled();

    // 50% of ttlSec=100 -> renew tick at 50_000ms.
    await vi.advanceTimersByTimeAsync(49_999);
    expect(renewDbLease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renewDbLease).toHaveBeenCalledWith(wrapper.leaseId, 100);
    expect(wrapper.swap).not.toHaveBeenCalled();

    await result.disconnect();
    expect(clearLeaseRenewer).toHaveBeenCalledTimes(1);
    expect(wrapper.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to wrapper.swap() when secrets.renewDbLease rejects', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';

    const wrapper = fakeWrapper();
    vaultPrismaCreate.mockResolvedValueOnce(wrapper);

    const renewDbLease = vi.fn(async () => {
      throw new Error('vault unreachable');
    });
    const secrets = { requestDbCredential: vi.fn(), renewDbLease } as never;

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory(secrets)!;
    const result = await factory();

    await vi.advanceTimersByTimeAsync(50_000);
    expect(renewDbLease).toHaveBeenCalledTimes(1);
    expect(wrapper.swap).toHaveBeenCalledTimes(1);

    await result.disconnect();
  });

  it('swaps instead of renewing once elapsed time is within the swap-safety margin of PG_VAULT_MAX_TTL_SEC', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';
    process.env.PG_VAULT_MAX_TTL_SEC = '40';

    const wrapper = fakeWrapper();
    vaultPrismaCreate.mockResolvedValueOnce(wrapper);

    const renewDbLease = vi.fn(async () => ({ ttlSec: 100 }));
    const secrets = { requestDbCredential: vi.fn(), renewDbLease } as never;

    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory(secrets)!;
    const result = await factory();

    // First tick at 50% of ttlSec=100 -> 50s elapsed, already past the
    // max_ttl(40s) minus margin threshold -> must swap, not renew.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(renewDbLease).not.toHaveBeenCalled();
    expect(wrapper.swap).toHaveBeenCalledTimes(1);

    await result.disconnect();
  });

  it('tolerates a secrets dependency with no setLeaseRenewer/renewDbLease (structural VaultDbSecretsLike callers)', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.PG_DYNAMIC_CREDS = 'true';

    const wrapper = fakeWrapper();
    vaultPrismaCreate.mockResolvedValueOnce(wrapper);

    const secrets = { requestDbCredential: vi.fn() } as never;
    const { buildVaultPrismaFactory } = await import('../vault-prisma.module');
    const factory = buildVaultPrismaFactory(secrets)!;
    const result = await factory();

    // No renewDbLease available -> renew tick must fall back to swap()
    // without throwing.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(wrapper.swap).toHaveBeenCalledTimes(1);

    await expect(result.disconnect()).resolves.toBeUndefined();
  });
});
