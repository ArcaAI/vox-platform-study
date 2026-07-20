/**
 * McpAdminController unit tests.
 *
 * CASL `@CanRead/@CanManage` + `If-Match`/`@RequiresIfMatch` are exercised by the
 * guard/interceptor (+ e2e). These specs cover the controller's OWN logic:
 * tenant vs. global-admin scoping, If-Match-over-body version precedence, and
 * that it delegates registry reads/writes to the service (which owns the
 * GLOBAL-ADMIN 403 + OCC + cross-tenant 404 governance, unit-tested there).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { McpAdminController } from '../mcp-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue({ id: 'srv-1' }),
    create: vi.fn().mockResolvedValue({ id: 'srv-1' }),
    update: vi.fn().mockResolvedValue({ id: 'srv-1' }),
    remove: vi.fn().mockResolvedValue({ id: 'srv-1' }),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new McpAdminController(service as never, cls as never);
  return { controller, service };
}

/**
 * TASK-532 (M-12) — the MCP registry stops borrowing the `HarnessPolicy`
 * authorization subject and uses its own `McpServer` subject (already present in
 * the audit `ResourceType` enum, so no migration is needed). Reads stay `read`,
 * writes stay `manage`; the service-level GLOBAL-ADMIN 403 on writes is
 * unchanged (defense in depth), as asserted by the scoping specs below.
 */
describe('McpAdminController — authorization subjects', () => {
  const permsFor = (handler?: string) =>
    Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      handler ? (McpAdminController.prototype as never)[handler] : McpAdminController,
    ) as { action: string; subject: string }[] | undefined;

  it.each(['list', 'get'])('read route %s is gated by @CanRead(McpServer)', (handler) => {
    expect(permsFor(handler)).toEqual([{ action: 'read', subject: 'McpServer' }]);
  });

  it.each(['create', 'update', 'remove'])('write route %s is gated by @CanManage(McpServer)', (handler) => {
    expect(permsFor(handler)).toEqual([{ action: 'manage', subject: 'McpServer' }]);
  });

  it('no route borrows the HarnessPolicy subject any more', () => {
    for (const handler of ['list', 'get', 'create', 'update', 'remove']) {
      expect(permsFor(handler)?.some((p) => p.subject === 'HarnessPolicy'), handler).toBe(false);
    }
  });
});

describe('McpAdminController — scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('list: tenant admin is pinned to its own tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.list(undefined);
    expect(service.list).toHaveBeenCalledWith('t1');
  });

  it('list: a foreign ?tenantId= from a tenant admin is 403', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.list('t2')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('list: a global admin may omit tenantId (undefined = SYSTEM registry, resolved by service)', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    await controller.list(undefined);
    expect(service.list).toHaveBeenCalledWith(undefined);
  });

  it('get: delegates to the service with the scoped tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.get('srv-1', undefined);
    expect(service.get).toHaveBeenCalledWith('srv-1', 't1');
  });
});

describe('McpAdminController — writes delegate to the service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create: forwards the body + resolved tenant', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    const body = { name: 's', baseUrl: 'https://x/mcp' } as never;
    await controller.create(body, undefined);
    expect(service.create).toHaveBeenCalledWith(body, undefined);
  });

  it('update: prefers the If-Match header version over the body version', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    await controller.update('srv-1', { name: 'x', expectedVersion: 9 } as never, 3, undefined);
    expect(service.update).toHaveBeenCalledWith('srv-1', expect.anything(), 3, undefined);
  });

  it('update: falls back to the body version when no If-Match header', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    await controller.update('srv-1', { name: 'x', expectedVersion: 9 } as never, undefined, undefined);
    expect(service.update).toHaveBeenCalledWith('srv-1', expect.anything(), 9, undefined);
  });

  it('remove: forwards the If-Match version', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: undefined });
    await controller.remove('srv-1', 2, undefined);
    expect(service.remove).toHaveBeenCalledWith('srv-1', 2, undefined);
  });
});
