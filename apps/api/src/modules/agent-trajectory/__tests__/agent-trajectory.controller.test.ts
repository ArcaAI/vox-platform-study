/**
 * AgentTrajectoryController unit tests (TASK-510 Phase 2D — admin read plane).
 *
 * The class-level `@CanManage('HarnessPolicy')` tuple + the tenant-owned 404
 * posture are exercised by the guard/interceptor (and e2e). These specs cover
 * the controller's OWN logic: the HarnessPolicy-family permission gate, the
 * global-admin vs. tenant read scoping forwarded to the service, keyset option
 * pass-through, the cross-tenant 404 propagation, and the guarantee that the
 * read projection NEVER carries `payloadRef`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { AgentSessionKind } from '@arcaai/domains';
import { AgentTrajectoryController } from '../agent-trajectory.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const service = {
    listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listSteps: vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false, limit: 50 }),
    aggregateGenerationStats: vi.fn().mockResolvedValue({
      sampleCount: 0,
      ttftMedianMs: null,
      ttftP95Ms: null,
      tokensPerSecondAvg: null,
      stopReasons: [],
    }),
    recordSteps: vi.fn(),
    pruneOlderThan: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new AgentTrajectoryController(service as never, cls as never);
  return { controller, service };
}

describe('AgentTrajectoryController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is class-gated by @CanManage(HarnessPolicy) (HarnessPolicy-family permission)', () => {
    const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AgentTrajectoryController) as
      | { action: string; subject: string }[]
      | undefined;
    expect(meta).toEqual([{ action: 'manage', subject: 'HarnessPolicy' }]);
  });

  describe('GET admin/agent-trajectory/sessions', () => {
    it('scopes to the caller tenant and forwards the filters + pagination', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });

      await controller.listSessions({
        consultationId: 'c1',
        kind: AgentSessionKind.HARNESS_DOC,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
        page: 2,
        limit: 10,
      } as never);

      expect(service.listSessions).toHaveBeenCalledWith(
        't1',
        { consultationId: 'c1', kind: AgentSessionKind.HARNESS_DOC, from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
        { page: 2, limit: 10 },
      );
    });

    it('lets a global-admin target another tenant via ?tenantId=', async () => {
      const { controller, service } = makeController({ user: SUPER, tenantId: 'sys' });

      await controller.listSessions({ tenantId: 't2' } as never);

      expect(service.listSessions).toHaveBeenCalledWith('t2', expect.anything(), expect.anything());
    });
  });

  describe('GET admin/agent-trajectory/sessions/:sessionId/steps', () => {
    it('forwards the sessionId + keyset options (runId, cursor, limit)', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });

      await controller.listSteps('sess-1', { runId: 'run-1', cursor: 'cur-1', limit: 25 } as never);

      expect(service.listSteps).toHaveBeenCalledWith('t1', 'sess-1', { runId: 'run-1', cursor: 'cur-1', limit: 25 });
    });

    it('propagates the service 404 (cross-tenant / nonexistent session → NotFound, never 403)', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      service.listSteps.mockRejectedValueOnce(new NotFoundException('Trajectory session not found'));

      await expect(controller.listSteps('sess-x', {} as never)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never exposes payloadRef on the step projection', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      service.listSteps.mockResolvedValueOnce({
        items: [{ id: 's1', seq: 0, stepType: 'LLM_CALL', name: 'generate' }],
        nextCursor: null,
        hasMore: false,
        limit: 50,
      });

      const res = await controller.listSteps('sess-1', {} as never);

      for (const item of res.items) {
        expect(item).not.toHaveProperty('payloadRef');
      }
    });
  });

  describe('GET admin/agent-trajectory/metrics/generation', () => {
    it('scopes to the caller tenant and forwards from/to/consultationId filters', async () => {
      const { controller, service } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
      service.aggregateGenerationStats.mockResolvedValueOnce({
        sampleCount: 2,
        ttftMedianMs: 160,
        ttftP95Ms: 196,
        tokensPerSecondAvg: 50,
        stopReasons: [{ reason: 'stop', count: 2 }],
      });

      const res = await controller.aggregateGenerationStats({
        consultationId: 'c1',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-19T00:00:00.000Z',
      } as never);

      expect(service.aggregateGenerationStats).toHaveBeenCalledWith('t1', {
        consultationId: 'c1',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-19T00:00:00.000Z',
      });
      expect(res.sampleCount).toBe(2);
      expect(res.ttftMedianMs).toBe(160);
    });

    it('lets a global-admin target another tenant via ?tenantId=', async () => {
      const { controller, service } = makeController({ user: SUPER, tenantId: 'sys' });

      await controller.aggregateGenerationStats({ tenantId: 't2' } as never);

      expect(service.aggregateGenerationStats).toHaveBeenCalledWith('t2', {
        consultationId: undefined,
        from: undefined,
        to: undefined,
      });
    });

    it('inherits class-level @CanManage(HarnessPolicy) (same gate as sessions)', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, AgentTrajectoryController) as
        | { action: string; subject: string }[]
        | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'HarnessPolicy' }]);
    });
  });
});
