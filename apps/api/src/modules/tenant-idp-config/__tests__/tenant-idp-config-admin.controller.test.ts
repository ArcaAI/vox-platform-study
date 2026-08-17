/**
 * TenantIdpConfigAdminController unit tests.
 *
 * CASL `@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ e2e). These specs cover the controller's OWN logic:
 * tenant vs. super-admin scoping (404-over-403 precedent — mirrors
 * `TenantTtsConfigAdminController`), and the If-Match-over-body version
 * precedence forwarded to the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantIdpConfigAdminController } from '../tenant-idp-config-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    testConnection: vi.fn(),
    setDirectoryCredentials: vi.fn(),
  };
  const directorySyncService = { enqueueSync: vi.fn() };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new TenantIdpConfigAdminController(service as never, directorySyncService as never, cls as never);
  return { controller, service, directorySyncService };
}

describe('TenantIdpConfigAdminController — scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their CLS tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.list.mockResolvedValue([]);
    await controller.list();
    expect(service.list).toHaveBeenCalledWith('t1');
  });

  it('rejects a tenant admin targeting another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getById('provider-1', 't2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super admin target any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.getById.mockResolvedValue({ id: 'provider-1', tenantId: 't9' });
    await controller.getById('provider-1', 't9');
    expect(service.getById).toHaveBeenCalledWith('t9', 'provider-1');
  });

  it('400s when a super admin omits ?tenantId= and has no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.list()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantIdpConfigAdminController — If-Match precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over a body-supplied expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.update.mockResolvedValue({ id: 'provider-1' });
    await controller.update('provider-1', { displayName: 'x', expectedVersion: 99 }, 3, 't1');
    expect(service.update).toHaveBeenCalledWith('t1', 'provider-1', { displayName: 'x', expectedVersion: 3 });
  });

  it('falls back to the body expectedVersion when no If-Match header is forwarded', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.update.mockResolvedValue({ id: 'provider-1' });
    await controller.update('provider-1', { displayName: 'x', expectedVersion: 2 }, undefined, 't1');
    expect(service.update).toHaveBeenCalledWith('t1', 'provider-1', { displayName: 'x', expectedVersion: 2 });
  });
});

describe('TenantIdpConfigAdminController — test-connection', () => {
  it('delegates to the service, scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.testConnection.mockResolvedValue({ ok: true, providerStatus: 'ENABLED' });
    const res = await controller.testConnection('provider-1', 't1');
    expect(service.testConnection).toHaveBeenCalledWith('t1', 'provider-1');
    expect(res.ok).toBe(true);
  });
});

describe('TenantIdpConfigAdminController — directory credentials', () => {
  it('delegates to the service, scoped to the caller tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.setDirectoryCredentials.mockResolvedValue({ id: 'provider-1' });
    const body = { credentials: { azureTenantId: 't', clientId: 'c', clientSecret: 's' } };
    await controller.setDirectoryCredentials('provider-1', body as never, 't1');
    expect(service.setDirectoryCredentials).toHaveBeenCalledWith('t1', 'provider-1', body);
  });

  it('rejects a tenant admin targeting another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.setDirectoryCredentials('provider-1', {} as never, 't2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TenantIdpConfigAdminController — sync', () => {
  it('delegates to DirectorySyncService, scoped to the caller tenant', async () => {
    const { controller, directorySyncService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    directorySyncService.enqueueSync.mockResolvedValue({ jobId: 'job-1' });
    const res = await controller.syncDirectory('provider-1', 't1');
    expect(directorySyncService.enqueueSync).toHaveBeenCalledWith('t1', 'provider-1');
    expect(res.jobId).toBe('job-1');
  });

  it('rejects a tenant admin targeting another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.syncDirectory('provider-1', 't2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
