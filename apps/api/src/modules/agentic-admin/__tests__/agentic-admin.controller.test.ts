/**
 * AgenticAdminController unit tests (TASK-511 Phase 3A item 6).
 *
 * The `@CanManage('HarnessPolicy')` tuple is exercised by the guard (+ e2e).
 * These specs cover the controller's OWN logic: read-tenant scoping (tenant
 * admin pinned to own tenant; global-admin targets `?tenantId=`), the
 * cross-tenant 404 posture, and query pass-through to the service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AgenticAdminController } from '../agentic-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    getEffectiveInstructions: vi.fn().mockResolvedValue({ tenantId: ctx.tenantId ?? 't1' }),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new AgenticAdminController(service as never, cls as never);
  return { controller, service };
}

describe('AgenticAdminController.getInstructions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their own tenant and forwards query narrowing', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.getInstructions({ departmentId: 'dep-1', promptType: 'revisit' });
    expect(service.getEffectiveInstructions).toHaveBeenCalledWith('t1', { departmentId: 'dep-1', promptType: 'revisit' });
  });

  it('lets a global-admin target a tenant via ?tenantId=', async () => {
    const { controller, service } = makeController({ user: SUPER });
    await controller.getInstructions({ tenantId: 't-other' });
    expect(service.getEffectiveInstructions).toHaveBeenCalledWith('t-other', { departmentId: undefined, promptType: undefined });
  });

  it('404s when a tenant admin requests a FOREIGN tenant (no existence leak)', async () => {
    const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getInstructions({ tenantId: 't-other' })).rejects.toBeInstanceOf(NotFoundException);
    expect(service.getEffectiveInstructions).not.toHaveBeenCalled();
  });

  it('400s a global-admin who omits ?tenantId= with no working tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.getInstructions({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires ["manage","HarnessPolicy"] on getInstructions', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AgenticAdminController.prototype.getInstructions);
    expect(meta).toEqual([{ action: 'manage', subject: 'HarnessPolicy' }]);
  });
});
