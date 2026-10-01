import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

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
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: vi.fn() }) }),
  }) as unknown as ExecutionContext;

describe('TenantLockGuard — categories', () => {
  it.each([[['CONFIG_CONTENT']], [['CONFIG_CONTENT', 'CLINICAL']]])('still 423s human traffic for a %j lock', async (categories) => {
    const guard = new TenantLockGuard(
      reflectorReturning(false),
      clsWith({ tenantId: 'T' }),
      lockService({ T: { locked: true, restoreId: 'R', categories } as never }),
    );
    await expect(guard.canActivate(httpContext())).rejects.toMatchObject({ status: 423 });
  });

  it('lets /internal/ callers through a CONFIG_CONTENT lock (503 only with CLINICAL)', async () => {
    const req = { url: '/api/v1/internal/stt/transcripts', headers: { 'x-tenant-id': 'T' } };
    const open = new TenantLockGuard(reflectorReturning(false), clsWith({}), lockService({ T: { locked: true, categories: ['CONFIG_CONTENT'] } as never }));
    await expect(open.canActivate(httpContext(req))).resolves.toBe(true);
    const shut = new TenantLockGuard(reflectorReturning(false), clsWith({}), lockService({ T: { locked: true, categories: ['CLINICAL'] } as never }));
    await expect(shut.canActivate(httpContext(req))).rejects.toMatchObject({ status: 503 });
  });
});

describe('TenantLockGuard — internal classification is by parsed PATH only (N-1)', () => {
  const config = { T: { locked: true, restoreId: 'R', categories: ['CONFIG_CONTENT'] } as never };

  it('a query string naming /internal/ does NOT make a user route internal: still 423', async () => {
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({ tenantId: 'T' }), lockService(config));
    const req = { originalUrl: '/api/v1/admin/x?y=/internal/', url: '/api/v1/admin/x?y=/internal/', headers: {} };
    await expect(guard.canActivate(httpContext(req))).rejects.toMatchObject({ status: 423 });
  });

  it('nor does it let a query-string trick pull the tenant from X-Tenant-Id', async () => {
    const lock = lockService(config);
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({}), lock);
    const req = { originalUrl: '/api/v1/auth/login?z=/internal/', headers: { 'x-tenant-id': 'T' } };
    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });

  it('a real /api/v1/internal/ path passes a CONFIG_CONTENT lock and 503s under CLINICAL', async () => {
    const req = { originalUrl: '/api/v1/internal/stt/transcripts', headers: { 'x-tenant-id': 'T' } };
    const open = new TenantLockGuard(reflectorReturning(false), clsWith({}), lockService(config));
    await expect(open.canActivate(httpContext(req))).resolves.toBe(true);
    const shut = new TenantLockGuard(reflectorReturning(false), clsWith({}), lockService({ T: { locked: true, categories: ['CLINICAL'] } as never }));
    await expect(shut.canActivate(httpContext(req))).rejects.toMatchObject({ status: 503 });
  });
});

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
    await expect(guard.canActivate(httpContext(req))).rejects.toMatchObject({ status: 503, response: { code: 'TENANT_RESTORE_IN_PROGRESS', restoreId: 'R' } });
  });

  it('does not trust X-Tenant-Id on non-internal routes', async () => {
    const lock = lockService({ T: { locked: true } });
    const guard = new TenantLockGuard(reflectorReturning(false), clsWith({}), lock);
    const req = { url: '/api/v1/auth/login', headers: { 'x-tenant-id': 'T' } };
    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
    expect(lock.state).not.toHaveBeenCalled();
  });
});
