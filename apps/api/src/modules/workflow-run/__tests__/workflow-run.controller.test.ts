/**
 * WorkflowRunController unit tests.
 *
 * The class-level `@CanRead('WorkflowRun')` gate, the tier 30-49 working-
 * tenant resolution (tenant admins pinned to their own CLS tenant; a
 * SUPER_ADMIN with no working tenant selected is rejected — mirrors
 * `DepartmentController.fetchAll`), keyset option pass-through, and the
 * cross-tenant 404 propagation from the service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { WorkflowRunController } from '../workflow-run.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    listRuns: vi.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false, limit: 20 }),
    getRun: vi.fn().mockResolvedValue({ id: 'run-row-1' }),
    getRunTrace: vi.fn().mockResolvedValue({ run: { id: 'run-row-1' }, nodes: [], stepCount: 0, truncated: false, tracePruned: false }),
    recordRunStarted: vi.fn(),
    recordRunFinished: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new WorkflowRunController(service as never, cls as never);
  return { controller, service };
}

describe('WorkflowRunController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is class-gated by @CanRead(WorkflowRun)', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, WorkflowRunController) as { action: string; subject: string }[] | undefined;
    expect(meta).toEqual([{ action: 'read', subject: 'WorkflowRun' }]);
  });

  describe('GET admin/workflow-runs', () => {
    it('scopes to the caller (working) tenant and forwards filters + keyset options', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });

      await controller.listRuns({
        workflowSlug: 'triage',
        status: 'FAILED',
        trigger: 'api invoke',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        includeSandbox: true,
        cursor: 'opaque',
        limit: 10,
      } as never);

      expect(service.listRuns).toHaveBeenCalledWith(
        't1',
        {
          workflowSlug: 'triage',
          workflowVersionId: undefined,
          status: 'FAILED',
          trigger: 'api invoke',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
          includeSandbox: true,
        },
        { cursor: 'opaque', limit: 10 },
      );
    });

    it('rejects a SUPER_ADMIN with no working tenant selected (403, never reaching the service)', async () => {
      const { controller, service } = makeController({ user: SUPER, tenantId: undefined });

      await expect(controller.listRuns({} as never)).rejects.toThrow(ForbiddenException);
      expect(service.listRuns).not.toHaveBeenCalled();
    });

    it('rejects a caller with no tenant context at all (403)', async () => {
      const { controller, service } = makeController({ user: null, tenantId: undefined });

      await expect(controller.listRuns({} as never)).rejects.toThrow(ForbiddenException);
      expect(service.listRuns).not.toHaveBeenCalled();
    });
  });

  describe('GET admin/workflow-runs/:runId', () => {
    it('forwards the working tenant + runId', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      await controller.getRun('run-1');
      expect(service.getRun).toHaveBeenCalledWith('t1', 'run-1');
    });

    it('propagates NotFoundException from the service (404-over-403)', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      service.getRun.mockRejectedValueOnce(new NotFoundException('WorkflowRun run-1 not found'));
      await expect(controller.getRun('run-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET admin/workflow-runs/:runId/trace', () => {
    it('forwards the working tenant + runId', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      await controller.getRunTrace('run-1');
      expect(service.getRunTrace).toHaveBeenCalledWith('t1', 'run-1');
    });
  });
});
