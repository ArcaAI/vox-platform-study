/**
 * TenantTtsConfigAdminController unit tests.
 *
 * CASL `@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ e2e). These specs cover the controller's OWN logic:
 * tenant vs. super-admin scoping, and the If-Match-over-body version precedence
 * forwarded to the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantTtsConfigAdminController } from '../tenant-tts-config-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    getEffective: vi.fn(),
    getRow: vi.fn(),
    upsertRow: vi.fn(),
    getPlatformCatalog: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new TenantTtsConfigAdminController(service as never, cls as never);
  return { controller, service };
}

describe('TenantTtsConfigAdminController — scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their CLS tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getEffective.mockResolvedValue({ tenantId: 't1' });
    await controller.getEffective();
    expect(service.getEffective).toHaveBeenCalledWith('t1');
  });

  it('rejects a tenant admin targeting another tenant', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow('t2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super admin target any tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    service.getRow.mockResolvedValue({ tenantId: 't9', version: 0 });
    await controller.getRow('t9');
    expect(service.getRow).toHaveBeenCalledWith('t9');
  });

  it('400s when a super admin omits ?tenantId= and has no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.getEffective()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TenantTtsConfigAdminController — If-Match precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', version: 3 });
    await controller.updateRow({ defaultSpeed: 2.0, expectedVersion: 1 }, 2, undefined);
    expect(service.upsertRow).toHaveBeenCalledWith('t1', expect.objectContaining({ defaultSpeed: 2.0, expectedVersion: 2 }));
  });

  it('falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.upsertRow.mockResolvedValue({ tenantId: 't1', version: 1 });
    await controller.updateRow({ expectedVersion: 0 }, undefined, undefined);
    expect(service.upsertRow).toHaveBeenCalledWith('t1', expect.objectContaining({ expectedVersion: 0 }));
  });
});

describe('TenantTtsConfigAdminController — platform catalog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET catalog delegates to getPlatformCatalog (tenant-agnostic — no tenant scoping)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const catalog = {
      providers: [
        { provider: 'azure', slug: 'azure-neural-voices', name: 'Azure Neural Voices', voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }] },
      ],
    };
    service.getPlatformCatalog.mockResolvedValue(catalog);

    await expect(controller.getCatalog()).resolves.toBe(catalog);
    expect(service.getPlatformCatalog).toHaveBeenCalledWith();
  });
});
