import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantLockGuard } from '../tenant-lock.guard';

const reflectorReturning = (value: boolean) => ({ getAllAndOverride: vi.fn().mockReturnValue(value) }) as unknown as Reflector;
const clsWith = (store: Record<string, unknown> | null) =>
  ({ isActive: () => store !== null, get: (key: string) => store?.[key] }) as never;
const lockService = (states: Record<string, { locked: boolean; restoreId?: string }>) => ({
  state: vi.fn(async (tenantId: string) => states[tenantId] ?? { locked: false }),
  publishChange: vi.fn(),
});
const httpContext = (req: Record<string, unknown> = { url: '/api/v1/admin/departments', headers: {} }, type = 'http') =>
  ({
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('TenantLockGuard', () => {
  it('423s a request whose CLS tenant is locked', async () => {
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lockService({ T: { locked: true, restoreId: 'R' } }));
    await expect(guard.canActivate(httpContext())).rejects.toMatchObject({
      status: 423,
      response: { statusCode: 423, code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
  });

  it('lets an unlocked tenant through', async () => {
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lockService({}));
    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
  });

  it('lets an exempt handler through without querying the lock', async () => {
    const lock = lockService({ T: { locked: true, restoreId: 'R' } });
    const guard = new TenantLockGuard(reflectorReturning(true), clsWith({ tenantId: 'T' }), lock);
    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('ignores requests with no tenant context', async () => {
    const lock = lockService({});
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({}), lock);
    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('ignores non-http contexts (ws is checked in the gateway)', async () => {
    const lock = lockService({ T: { locked: true } });
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lock);
    await expect(guard.canActivate(httpContext(undefined, 'ws'))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the lock state cannot be read', async () => {
    const lock = { state: vi.fn().mockRejectedValue(new Error('db down')), publishChange: vi.fn() };
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lock);
    await expect(guard.canActivate(httpContext())).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_LOCK_UNAVAILABLE' },
    });
  });

  it('falls back to X-Tenant-Id on internal routes that have no CLS tenant yet', async () => {
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({}), lockService({ T: { locked: true, restoreId: 'R' } }));
    const req = { url: '/api/v1/internal/harness/policy', headers: { 'x-tenant-id': 'T' } };
    await expect(guard.canActivate(httpContext(req))).rejects.toMatchObject({ status: 423 });
  });

  it('does not trust X-Tenant-Id on non-internal routes', async () => {
    const lock = lockService({ T: { locked: true } });
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({}), lock);
    const req = { url: '/api/v1/auth/login', headers: { 'x-tenant-id': 'T' } };
    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });
});
