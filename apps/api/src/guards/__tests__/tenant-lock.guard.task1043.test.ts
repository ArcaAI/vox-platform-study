import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { TenantLockGuard } from '../tenant-lock.guard';
import { InternalTenantLockGuard } from '../internal-tenant-lock.guard';
import { TENANT_LOCK_EXEMPT_KEY } from '../../decorators/tenant-lock-exempt.decorator';

/**
 * `@Public()` internal routes authenticate in a CONTROLLER guard, which Nest runs after every global
 * guard. A global lock read there runs for a caller who has presented no credential: a locked tenant
 * answered 503 + its restoreId, an unlocked one fell through to the token guard's 401 — an
 * unauthenticated oracle over which tenants are being restored. The lock check for those routes
 * belongs to `InternalTenantLockGuard`, placed after the token guard.
 */

const reflectorWith = (metadata: Record<string, unknown>) =>
  ({ getAllAndOverride: vi.fn((key: string) => metadata[key]) }) as unknown as Reflector;
const noCls = { isActive: () => true, get: () => undefined } as never;
const lockService = (states: Record<string, unknown>) => ({
  state: vi.fn(async (tenantId: string) => (states[tenantId] as never) ?? { locked: false }),
  publishChange: vi.fn(),
});
const clinical = { T: { locked: true, restoreId: 'R', categories: ['CLINICAL'] } };

const httpContext = (req: Record<string, unknown>, setHeader = vi.fn()) =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }),
  }) as unknown as ExecutionContext;

const internalReq = (method = 'GET') => ({
  method,
  originalUrl: '/api/v1/internal/agents/resolve',
  headers: { 'x-tenant-id': 'T' },
  query: {},
  body: {},
});

describe('TenantLockGuard — @Public() internal routes are left to the post-auth guard (TASK-1043)', () => {
  it.each([[SKIP_AUTH_KEY], ['isPublic']])('does not read the lock for X-Tenant-Id on a route marked %s', async (key) => {
    const lock = lockService(clinical);
    const guard = new TenantLockGuard(reflectorWith({ [key]: true }), noCls, lock);
    await expect(guard.canActivate(httpContext(internalReq()))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('still enforces the lock on an internal route authenticated by the global auth guard (not @Public)', async () => {
    const guard = new TenantLockGuard(reflectorWith({}), noCls, lockService(clinical));
    await expect(guard.canActivate(httpContext(internalReq()))).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
  });

  it('keeps honouring the lock-exempt marker', async () => {
    const lock = lockService(clinical);
    const guard = new TenantLockGuard(reflectorWith({ [TENANT_LOCK_EXEMPT_KEY]: true }), noCls, lock);
    await expect(guard.canActivate(httpContext(internalReq()))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });
});

describe('InternalTenantLockGuard — takes over the X-Tenant-Id rule after authentication (TASK-1043)', () => {
  it.each(['GET', 'HEAD', 'POST'])('%s naming a CLINICAL-locked tenant in X-Tenant-Id → 503 + Retry-After', async (method) => {
    const setHeader = vi.fn();
    const guard = new InternalTenantLockGuard(lockService(clinical));
    await expect(guard.canActivate(httpContext(internalReq(method), setHeader))).rejects.toMatchObject({
      status: 503,
      response: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' },
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('a read naming the tenant only in the query still passes without a lock read (unchanged)', async () => {
    const lock = lockService(clinical);
    const guard = new InternalTenantLockGuard(lock);
    const req = { method: 'GET', headers: {}, query: { tenantId: 'T' }, body: {} };
    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('a read with only x-internal-tenant-id still passes without a lock read (unchanged)', async () => {
    const lock = lockService(clinical);
    const guard = new InternalTenantLockGuard(lock);
    const req = { method: 'GET', headers: { 'x-internal-tenant-id': 'T' }, query: {}, body: {} };
    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });
});
