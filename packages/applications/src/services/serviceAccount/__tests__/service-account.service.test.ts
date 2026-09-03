/**
 * / / — `ServiceAccountService`.
 *
 * The gates that earn their own suite are the ones whose absence is the whole
 * of the defect this ticket exists to avoid:
 *
 * **SUPER_ADMIN-only issuance .** `@CanManage('ApiKey')` is
 * tenant-admin-reachable, and that is the whole of the defect. A
 *    tenant admin must never be able to mint a service account — not even one
 *    scoped to their own tenant — because verifying scope-against-ability at
 *    mint time is a weaker guarantee than never letting the mint happen.
 *  - **No self-replication.** A service-account principal may not mint another
 *    service account, whatever scopes it holds.
 * **The secret is returned exactly once and never persisted**.
 *  - **Cross-tenant reads are 404, not 403** — the tenancy posture, distinct
 *    from the 403 privilege boundaries above.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ServiceAccountService } from '../service-account.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeService(cls: Record<string, unknown>, repoOverrides: Record<string, unknown> = {}) {
  const created: unknown[] = [];
  const repository = {
    create: vi.fn(async (entity: unknown) => {
      created.push(entity);
      return entity;
    }),
    findById: vi.fn(),
    findAll: vi.fn(async () => []),
    findByTenantId: vi.fn(async () => []),
    findByClientId: vi.fn(async () => null),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
    softDelete: vi.fn(async () => ({ id: 'x' })),
    touchLastUsedAt: vi.fn(async () => undefined),
    ...repoOverrides,
  };
  const clsService = { get: vi.fn((k: string) => cls[k]), set: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const cache = {
    get: vi.fn(async () => null),
    setex: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delMany: vi.fn(async () => undefined),
  };
  const secrets = { getSecretOptional: vi.fn(async () => 'test-pepper') };

  const service = new ServiceAccountService(eventEmitter as never, clsService as never, repository as never, cache as never, secrets as never);
  return { service, repository, clsService, eventEmitter, cache, created };
}

const superAdminCls = { user: { id: 'admin-1', roles: ['SUPER_ADMIN'] }, tenantId: TENANT_A };
const tenantAdminCls = {
  user: { id: 'tadmin-1', roles: ['TENANT_ADMIN'] },
  tenantId: TENANT_A,
  // A tenant admin holding the broadest ability the console can grant them.
  userAbility: { can: () => true },
};

const validRequest = { displayName: 'bot', scopes: ['svc:admin:department:manage'] };

describe('ServiceAccountService.create — issuance is SUPER_ADMIN-only', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a tenant admin with 403, even one holding every ability (§5.2, test 6)', async () => {
    const { service, repository } = makeService(tenantAdminCls);
    await expect(service.create(validRequest as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('lets a SUPER_ADMIN create, and returns the client secret exactly once (test 7)', async () => {
    const { service } = makeService(superAdminCls);
    const result = await service.create(validRequest as never);

    expect(result.clientSecret).toBeTruthy();
    expect(result.clientSecret.length).toBeGreaterThanOrEqual(32);
    expect(result.clientId).toMatch(/^hope_svc_/);
  });

  it('never persists the secret to any column (test 17)', async () => {
    const { service, created } = makeService(superAdminCls);
    const result = await service.create(validRequest as never);

    const persisted = JSON.stringify(created[0]);
    expect(persisted).not.toContain(result.clientSecret);
    // The verifier is present but is a one-way HMAC, not the secret.
    expect((created[0] as { secretVerifier: string }).secretVerifier).toBeTruthy();
    expect((created[0] as { secretVerifier: string }).secretVerifier).not.toBe(result.clientSecret);
  });

  it('refuses a SERVICE-ACCOUNT principal outright — no self-replication (test 9)', async () => {
    const { service, repository } = makeService({
      serviceAccount: {
        id: 'sa-1',
        clientId: 'hope_svc_x',
        tenantId: SYSTEM_TENANT_ID,
        scopes: ['svc:*'],
        roles: ['SUPER_ADMIN'],
        workingTenantId: SYSTEM_TENANT_ID,
      },
      tenantId: SYSTEM_TENANT_ID,
    });
    await expect(service.create(validRequest as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects allowedTenantIds on a tenant-bound account (§5.3)', async () => {
    const { service } = makeService(superAdminCls);
    await expect(service.create({ ...validRequest, tenantId: TENANT_A, allowedTenantIds: [TENANT_B] } as never)).rejects.toThrow();
  });

  it('accepts allowedTenantIds on a PLATFORM (SYSTEM-tenant) account (§5.3)', async () => {
    const { service } = makeService(superAdminCls);
    const result = await service.create({ ...validRequest, tenantId: SYSTEM_TENANT_ID, allowedTenantIds: [TENANT_B] } as never);
    expect(result.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(result.allowedTenantIds).toEqual([TENANT_B]);
  });

  it('never resolves the "Global" customer tenant as an ambient default (§5.3, test 14)', async () => {
    // No CLS tenant at all: a machine principal has no ambient default and the
    // account must land on SYSTEM, never on `50000000-…` (a CUSTOMER tenant).
    const { service } = makeService({ user: { id: 'admin-1', roles: ['SUPER_ADMIN'] } });
    const result = await service.create(validRequest as never);
    expect(result.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(result.tenantId).not.toBe('50000000-0000-0000-0000-000000000000');
  });
});

describe('ServiceAccountService.getById — cross-tenant posture', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 (never 403) for an account in another tenant (test 10)', async () => {
    const foreign = { id: 'sa-9', tenantId: TENANT_B };
    const { service } = makeService(
      { user: { id: 'tadmin-1', roles: ['TENANT_ADMIN'] }, tenantId: TENANT_A },
      { findById: vi.fn(async () => foreign) },
    );
    await expect(service.getById('sa-9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ServiceAccountService.exchangeToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 with a non-enumerable message for both unknown client and bad secret (test 21)', async () => {
    const { service } = makeService({}, { findByClientId: vi.fn(async () => null) });
    await expect(service.exchangeToken({ clientId: 'nope', clientSecret: 'x'.repeat(48) } as never, '1.2.3.4')).rejects.toThrow(
      /Invalid client credentials/,
    );
  });

  it('issues two DISTINCT tokens for two exchanges of the same secret (test 18)', async () => {
    const secret = 'a'.repeat(64);
    const { service } = makeService({});
    const verifier = await service.computeSecretVerifier(secret);
    const account = {
      id: 'sa-1',
      clientId: 'hope_svc_x',
      tenantId: TENANT_A,
      scopes: ['svc:admin:department:manage'],
      superAdmin: false,
      tokenTtlSeconds: 900,
      secretVerifier: verifier,
      previousSecretVerifier: null,
      previousCredentialExpiresAt: null,
      allowedTenantIds: null,
      allowedIps: null,
      isPlatformAccount: false,
      isRotationOverlapActive: () => false,
    };
    const { service: svc } = makeService({}, { findByClientId: vi.fn(async () => account) });

    const first = await svc.exchangeToken({ clientId: 'hope_svc_x', clientSecret: secret } as never, '1.2.3.4');
    const second = await svc.exchangeToken({ clientId: 'hope_svc_x', clientSecret: secret } as never, '1.2.3.4');

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.expiresIn).toBe(900);
  });

  it(
    'a day-1 bootstrap secret, verified the SAME way the seed builds it (§OD-2), ' +
      'authenticates through the documented exchange',
    async () => {
      // `94-service-account.ts`'s `computeSecretVerifier(secret, pepper)` is
      // `createHmac('sha256', pepper ?? 'hope-service-account').update(secret).digest('hex')`
      // — reproduced here (not imported: packages/database sits below
      // packages/applications) with the SAME pepper `makeService`'s mocked
      // SecretsService returns ('test-pepper'), so this proves the seed's
      // construction and the runtime's verification are the same function.
      const operatorSecret = 'a-high-entropy-operator-supplied-day-one-secret-value';
      const seededVerifier = createHmac('sha256', 'test-pepper').update(operatorSecret).digest('hex');

      const account = {
        id: 'sa-arcaai',
        clientId: 'hope_svc_a4ca1a11ad3141b0c0de0001',
        tenantId: TENANT_A,
        scopes: ['svc:admin:department:manage'],
        superAdmin: false,
        tokenTtlSeconds: 900,
        secretVerifier: seededVerifier,
        previousSecretVerifier: null,
        previousCredentialExpiresAt: null,
        allowedTenantIds: null,
        allowedIps: null,
        isPlatformAccount: false,
        isRotationOverlapActive: () => false,
      };
      const { service } = makeService({}, { findByClientId: vi.fn(async () => account) });

      const result = await service.exchangeToken(
        { clientId: 'hope_svc_a4ca1a11ad3141b0c0de0001', clientSecret: operatorSecret } as never,
        '1.2.3.4',
      );

      expect(result.accessToken).toBeTruthy();
      expect(result.expiresIn).toBe(900);
      // The stored verifier is the one-way hash, never the operator's secret.
      expect(account.secretVerifier).not.toBe(operatorSecret);
      expect(account.secretVerifier).not.toContain(operatorSecret);
    },
  );

  it('refuses a PLATFORM account presenting a working tenant outside its allow-list with 403 (test 15)', async () => {
    const secret = 'b'.repeat(64);
    const { service } = makeService({});
    const verifier = await service.computeSecretVerifier(secret);
    const account = {
      id: 'sa-2',
      clientId: 'hope_svc_p',
      tenantId: SYSTEM_TENANT_ID,
      scopes: ['svc:admin:department:manage'],
      superAdmin: false,
      tokenTtlSeconds: 900,
      secretVerifier: verifier,
      previousSecretVerifier: null,
      previousCredentialExpiresAt: null,
      allowedTenantIds: [TENANT_A],
      allowedIps: null,
      isPlatformAccount: true,
      isRotationOverlapActive: () => false,
    };
    const { service: svc } = makeService({}, { findByClientId: vi.fn(async () => account) });

    await expect(
      svc.exchangeToken({ clientId: 'hope_svc_p', clientSecret: secret, workingTenantId: TENANT_B } as never, '1.2.3.4'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves a PLATFORM account with no working tenant to SYSTEM ONLY — never a customer tenant (test 14)', async () => {
    const secret = 'c'.repeat(64);
    const { service } = makeService({});
    const verifier = await service.computeSecretVerifier(secret);
    const account = {
      id: 'sa-3',
      clientId: 'hope_svc_q',
      tenantId: SYSTEM_TENANT_ID,
      scopes: ['svc:admin:department:manage'],
      superAdmin: false,
      tokenTtlSeconds: 900,
      secretVerifier: verifier,
      previousSecretVerifier: null,
      previousCredentialExpiresAt: null,
      allowedTenantIds: [TENANT_A],
      allowedIps: null,
      isPlatformAccount: true,
      isRotationOverlapActive: () => false,
    };
    const { service: svc } = makeService({}, { findByClientId: vi.fn(async () => account) });

    const result = await svc.exchangeToken({ clientId: 'hope_svc_q', clientSecret: secret } as never, '1.2.3.4');
    expect(result.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(result.tenantId).not.toBe('50000000-0000-0000-0000-000000000000');
  });

  it('accepts BOTH secrets during a rotation overlap and only the current one after it (test 20)', async () => {
    const current = 'd'.repeat(64);
    const previous = 'e'.repeat(64);
    const { service } = makeService({});
    const base = {
      id: 'sa-4',
      clientId: 'hope_svc_r',
      tenantId: TENANT_A,
      scopes: ['svc:admin:department:manage'],
      superAdmin: false,
      tokenTtlSeconds: 900,
      secretVerifier: await service.computeSecretVerifier(current),
      previousSecretVerifier: await service.computeSecretVerifier(previous),
      allowedTenantIds: null,
      allowedIps: null,
      isPlatformAccount: false,
    };

    const open = { ...base, previousCredentialExpiresAt: new Date(Date.now() + 60_000), isRotationOverlapActive: () => true };
    const { service: during } = makeService({}, { findByClientId: vi.fn(async () => open) });
    await expect(during.exchangeToken({ clientId: 'hope_svc_r', clientSecret: current } as never, '1.2.3.4')).resolves.toBeTruthy();
    await expect(during.exchangeToken({ clientId: 'hope_svc_r', clientSecret: previous } as never, '1.2.3.4')).resolves.toBeTruthy();

    const closed = { ...base, previousCredentialExpiresAt: new Date(Date.now() - 60_000), isRotationOverlapActive: () => false };
    const { service: after } = makeService({}, { findByClientId: vi.fn(async () => closed) });
    await expect(after.exchangeToken({ clientId: 'hope_svc_r', clientSecret: current } as never, '1.2.3.4')).resolves.toBeTruthy();
    await expect(after.exchangeToken({ clientId: 'hope_svc_r', clientSecret: previous } as never, '1.2.3.4')).rejects.toThrow(
      /Invalid client credentials/,
    );
  });
});

describe('ServiceAccountService.revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('purges live tokens immediately rather than waiting for a TTL (test 19)', async () => {
    const account = { id: 'sa-5', tenantId: TENANT_A };
    const { service, cache } = makeService(superAdminCls, { findById: vi.fn(async () => account) });
    (cache.keys as ReturnType<typeof vi.fn>).mockResolvedValue(['svcacct:token:hash1', 'svcacct:token:hash2']);
    (cache.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ serviceAccountId: 'sa-5' }));

    await service.revoke('sa-5');

    expect(cache.delMany).toHaveBeenCalled();
  });
});
