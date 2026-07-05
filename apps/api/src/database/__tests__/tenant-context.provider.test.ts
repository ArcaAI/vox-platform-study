/**
 * TASK-305 Phase B.7 unit test — `ClsTenantContextProvider`.
 *
 * Verifies the CLS ↔ Prisma-extension adapter without booting NestJS or
 * touching a real database. We construct a minimal `ClsService` stub and
 * assert the four contract points the audit cares about:
 *   1. Outside any CLS context  → tenantId undefined, isSuperAdmin true
 *      (preserves CLI / startup-hook pass-through).
 *   2. Inside CLS, no `tenantId` claim, regular user → tenantId undefined,
 *      isSuperAdmin false (causes the extension to throw, which is what
 *      we want — the call site forgot to plumb tenant context).
 *   3. Inside CLS, tenantId set on the store directly → returns it.
 *   4. Inside CLS, tenantId set on the user → falls back to user.tenantId.
 *   5. Inside CLS, user has GLOBAL_ADMIN_ROLE → isSuperAdmin true.
 *
 * Bootstrap / shutdown side-effects (`setTenantContextProvider`) are
 * covered by spying on the module rather than running NestJS lifecycle.
 */

import {
  setTenantContextProvider,
  type TenantContextProvider,
} from '@arcaai/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClsTenantContextProvider } from '../tenant-context.provider';

vi.mock('@arcaai/database', async () => {
  const actual = await vi.importActual<typeof import('@arcaai/database')>(
    '@arcaai/database',
  );
  return {
    ...actual,
    setTenantContextProvider: vi.fn(),
  };
});

interface ClsStub {
  active: boolean;
  store: { tenantId?: string; user?: { tenantId?: string; roles?: string[] } };
}

function makeCls(stub: ClsStub) {
  return {
    isActive: () => stub.active,
    get: (key: string) => {
      if (key === 'tenantId') return stub.store.tenantId;
      if (key === 'user') return stub.store.user;
      return undefined;
    },
  } as unknown as ConstructorParameters<typeof ClsTenantContextProvider>[0];
}

describe('ClsTenantContextProvider', () => {
  beforeEach(() => {
    vi.mocked(setTenantContextProvider).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outside CLS — tenantId undefined and isSuperAdmin true (pass-through)', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({ active: false, store: {} }),
    );
    expect(provider.getTenantId()).toBeUndefined();
    expect(provider.isSuperAdmin()).toBe(true);
  });

  it('inside CLS, no claims — tenantId undefined and isSuperAdmin false (forces extension throw)', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({ active: true, store: {} }),
    );
    expect(provider.getTenantId()).toBeUndefined();
    expect(provider.isSuperAdmin()).toBe(false);
  });

  it('reads tenantId from the CLS store directly when present', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({ active: true, store: { tenantId: 'tenant-A' } }),
    );
    expect(provider.getTenantId()).toBe('tenant-A');
  });

  it('falls back to user.tenantId when the store key is missing', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({
        active: true,
        store: { user: { tenantId: 'tenant-from-user', roles: ['User'] } },
      }),
    );
    expect(provider.getTenantId()).toBe('tenant-from-user');
  });

  // TASK-417 — SUPER_ADMIN is retired: the literal must NOT elevate at the
  // DB-extension layer anymore.
  it('isSuperAdmin is FALSE for the retired SUPER_ADMIN role literal', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({
        active: true,
        store: { tenantId: 't', user: { roles: ['SUPER_ADMIN', 'User'] } },
      }),
    );
    expect(provider.isSuperAdmin()).toBe(false);
  });

  // AC-06 (TASK-336) / TASK-417 — GLOBAL_ADMIN is the single elevated role
  // that receives the cross-tenant pass-through at the DB-extension layer.
  it('isSuperAdmin reflects the GLOBAL_ADMIN role on the user', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({
        active: true,
        store: { tenantId: 't', user: { roles: ['GLOBAL_ADMIN', 'User'] } },
      }),
    );
    expect(provider.isSuperAdmin()).toBe(true);
  });

  it('onApplicationBootstrap registers the provider; shutdown clears it', () => {
    const provider = new ClsTenantContextProvider(
      makeCls({ active: false, store: {} }),
    );
    provider.onApplicationBootstrap();
    expect(setTenantContextProvider).toHaveBeenCalledWith(
      provider satisfies TenantContextProvider,
    );

    provider.onApplicationShutdown();
    expect(setTenantContextProvider).toHaveBeenLastCalledWith(null);
  });
});
