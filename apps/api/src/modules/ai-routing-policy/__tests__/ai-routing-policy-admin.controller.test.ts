/**
 * AiRoutingPolicyAdminController unit tests.
 *
 * The privilege boundary itself lives in the SERVICE (and is tested there);
 * CASL and `If-Match` are exercised by the guard/interceptor and e2e. These
 * specs cover the controller's OWN logic: task-key validation (400), tenant
 * scoping through `resolveScopedTenantId`, `If-Match`-over-body version
 * precedence, query coercion on the effective route, and the fact that the
 * service's 403/404 pass through unaltered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { API_KEY_FORBIDDEN, SERVICE_ACCOUNT_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { AiRoutingPolicyAdminController } from '../ai-routing-policy-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

function makeController(ctx: Ctx) {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue({}),
    getEffective: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    activate: vi.fn().mockResolvedValue({}),
    deleteById: vi.fn().mockResolvedValue({}),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new AiRoutingPolicyAdminController(service as never, cls as never);
  return { controller, service };
}

describe('task-key validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s an unknown taskKey on the effective route before reaching the service', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await expect(controller.getEffective('not.a.task')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getEffective).not.toHaveBeenCalled();
  });

  it('400s a MISSING taskKey on the effective route', async () => {
    const { controller } = makeController({ user: SUPER, tenantId: 't1' });
    await expect(controller.getEffective(undefined as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s an unknown taskKey filter on list', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await expect(controller.list('t1', 'not.a.task')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a super admin target another tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 'working-tenant' });
    await controller.list('other-tenant');
    expect(service.list).toHaveBeenCalledWith('other-tenant', undefined);
  });

  it('lets a super admin address the SYSTEM platform-default row', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 'working-tenant' });
    await controller.getEffective('text.finalize', SYSTEM_TENANT);
    expect(service.getEffective).toHaveBeenCalledWith(SYSTEM_TENANT, 'text.finalize', expect.anything());
  });

  it('falls back to the working tenant elevated into the request context', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 'working-tenant' });
    await controller.list();
    expect(service.list).toHaveBeenCalledWith('working-tenant', undefined);
  });

  it('pins a tenant-bound caller to its own tenant', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.list();
    expect(service.list).toHaveBeenCalledWith('t1', undefined);
  });

  it('403s a tenant-bound caller reaching for a FOREIGN ?tenantId=', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.list('t2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('the two failure modes stay distinct', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes a privilege failure through as 403', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getById.mockRejectedValue(new ForbiddenException('super admins only'));
    await expect(controller.getById('p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes a cross-tenant id through as 404 — never 403', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    service.getById.mockRejectedValue(new NotFoundException('not found'));
    await expect(controller.getById('p1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('optimistic concurrency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over a body-supplied one', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await controller.update('p1', { killSwitch: true, expectedVersion: 1 }, 9);
    expect(service.update).toHaveBeenCalledWith('p1', 't1', expect.objectContaining({ expectedVersion: 9 }));
  });

  it('falls back to the body version when no header is present', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await controller.update('p1', { killSwitch: true, expectedVersion: 3 }, undefined);
    expect(service.update).toHaveBeenCalledWith('p1', 't1', expect.objectContaining({ expectedVersion: 3 }));
  });

  it('forwards the If-Match version to activate', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await controller.activate('p1', 4);
    expect(service.activate).toHaveBeenCalledWith('p1', 't1', 4);
  });
});

describe('effective-route query coercion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coerces contextTokens and allowFallbacks off the query string', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await controller.getEffective('text.finalize', undefined, 'gpt-4o-class', '2048', 'azure', 'true');
    expect(service.getEffective).toHaveBeenCalledWith('t1', 'text.finalize', {
      model: 'gpt-4o-class',
      contextTokens: 2048,
      explicitProvider: 'azure',
      allowFallbacks: true,
    });
  });

  it('400s a non-numeric contextTokens rather than passing NaN into the matcher', async () => {
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await expect(controller.getEffective('text.finalize', undefined, undefined, 'lots')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getEffective).not.toHaveBeenCalled();
  });

  it('treats any allowFallbacks value other than "true" as NOT opting in', async () => {
    // Opting in to fallbacks is a deliberate act; "1"/"yes"/absent are not it.
    const { controller, service } = makeController({ user: SUPER, tenantId: 't1' });
    await controller.getEffective('text.finalize', undefined, undefined, undefined, 'azure', '1');
    expect(service.getEffective).toHaveBeenCalledWith('t1', 'text.finalize', expect.objectContaining({ allowFallbacks: false }));
  });
});

/**
 * The credential-class declarations are DECLARATIVE, so they regress silently:
 * nothing in this controller's own logic changes if a decorator is dropped, and
 * the failure surfaces only as a boot-time refusal (TASK-762/773 assertion G) or,
 * worse, as a machine identity quietly gaining reach it was never granted.
 *
 * The class header records the decision: routing policy is machine-CLOSED,
 * because a policy write redirects PHI to a different vendor. `@ForbidApiKey()`
 * states it for the API-key class; `@ForbidServiceAccount()` must state it for
 * the service-account class, exactly as MonitoringController does — a comment
 * alone is not a declaration, and the boot audit refuses to start without one.
 */
describe('credential classes', () => {
  const reflector = new Reflector();

  it('forbids API keys at the class level (the admin-plane rule)', () => {
    expect(reflector.get(API_KEY_FORBIDDEN, AiRoutingPolicyAdminController)).toBe(true);
  });

  it('forbids service accounts at the class level — a routing write redirects PHI to another vendor', () => {
    expect(reflector.get(SERVICE_ACCOUNT_FORBIDDEN, AiRoutingPolicyAdminController)).toBe(true);
  });

  it('declares NO svc:* scope — opening this area is a new owner decision, not a code-review call', () => {
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, AiRoutingPolicyAdminController)).toBeUndefined();
  });
});
