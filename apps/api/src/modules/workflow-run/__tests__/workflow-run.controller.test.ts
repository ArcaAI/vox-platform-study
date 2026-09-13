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
import { WorkflowRunModule } from '../workflow-run.module';

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
  const usageAnalytics = { getWorkflowRunCpuSeconds: vi.fn().mockResolvedValue(null) };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new WorkflowRunController(service as never, usageAnalytics as never, cls as never);
  return { controller, service, usageAnalytics };
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

describe('GET admin/workflow-runs/:runId — cpuSeconds (TASK-959 §3.4)', () => {
  beforeEach(() => vi.clearAllMocks());

  // Keyed on the run's SESSION id, not the path's run id (corrected under
  // TASK-957): the ledger's `requestId` on a WORKFLOW row is Temporal's
  // execution-attempt id, so the domain run id matched nothing and a real run
  // answered `cpuSeconds: null` over four CPU_SECOND rows. `sessionId` is the
  // key `WorkflowRun` already joins its own trajectory steps by, so the ledger
  // read reuses that join rather than inventing a second one.
  it('decorates the run row with the ledger sum for that run\u2019s SESSION, tenant-scoped', async () => {
    const { controller, service, usageAnalytics } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getRun.mockResolvedValue({ id: 'run-row-1', runId: 'run-7', sessionId: 'workflow-interpreter-run-7', tenantId: 't1' });
    usageAnalytics.getWorkflowRunCpuSeconds.mockResolvedValue(12.75);

    const response = await controller.getRun('run-7');

    expect(usageAnalytics.getWorkflowRunCpuSeconds).toHaveBeenCalledWith('t1', 'workflow-interpreter-run-7');
    expect(response.cpuSeconds).toBe(12.75);
    // Purely additive — the run row the service returned is passed through whole.
    expect(response.id).toBe('run-row-1');
    expect(response.runId).toBe('run-7');
  });

  it('reports null when the run has no worker-CPU rows, never 0', async () => {
    const { controller, usageAnalytics } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    usageAnalytics.getWorkflowRunCpuSeconds.mockResolvedValue(null);

    // A run from before the metering interceptor shipped is not a run that
    // burned no CPU, and the detail screen must be able to tell them apart.
    expect((await controller.getRun('run-7')).cpuSeconds).toBeNull();
  });

  it('does not read the ledger at all when the run itself is not the caller\u2019s (404 first)', async () => {
    const { controller, service, usageAnalytics } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    service.getRun.mockRejectedValue(new NotFoundException('Run not found'));

    await expect(controller.getRun('run-7')).rejects.toBeInstanceOf(NotFoundException);
    expect(usageAnalytics.getWorkflowRunCpuSeconds).not.toHaveBeenCalled();
  });

  it('leaves the list route undecorated — a per-run ledger sum per row would be N queries', async () => {
    const { controller, usageAnalytics } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });

    await controller.listRuns({} as never);

    expect(usageAnalytics.getWorkflowRunCpuSeconds).not.toHaveBeenCalled();
  });
});

describe('WorkflowRunModule wiring', () => {
  it('imports a module that EXPORTS IUsageAnalyticsService, so the controller can inject it', async () => {
    // The failure this catches only ever appears at BOOT: a controller that
    // injects a token no imported module exports is a compile-clean,
    // unit-test-clean Nest startup failure. Asserting the module graph is the
    // cheapest place to catch it without a live database.
    const { IUsageAnalyticsService, UsageAnalyticsServiceModule } = await import('@arcaai/applications');
    const imports = (Reflect.getMetadata('imports', WorkflowRunModule) ?? []) as unknown[];

    expect(imports).toContain(UsageAnalyticsServiceModule);
    expect((Reflect.getMetadata('exports', UsageAnalyticsServiceModule) ?? []) as unknown[]).toContain(IUsageAnalyticsService);
  });
});
