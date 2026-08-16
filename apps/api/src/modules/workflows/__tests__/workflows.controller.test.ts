/**
 * WorkflowsController unit tests (TASK-722 Task 6).
 *
 * Asserts every route carries BOTH an authorization decorator (deny-by-default
 * boot audit, rule 05) AND `@RequiredScopes(...)` (the API-key path,
 * independent of the JWT/CASL path) — mirrors `api-key-scope-audit.test.ts`'s
 * own metadata-reading style — and that the controller is a thin pass-through
 * with zero business logic (delegates to `IWorkflowExposureService` /
 * `WorkflowStreamService` verbatim).
 */
import { describe, it, expect, vi } from 'vitest';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';
import { WorkflowsController } from '../workflows.controller';

function makeController() {
  const workflowExposureService = {
    list: vi.fn().mockResolvedValue({ data: [] }),
    invoke: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/x', streamUrl: '/x/stream' }),
    getRunStatus: vi.fn().mockResolvedValue({ runId: 'run-1', slug: 's', workflowVersionNumber: 1, status: 'RUNNING', stages: [], startedAt: null, endedAt: null }),
    cancelRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' }),
  };
  const workflowStreamService = { stream: vi.fn().mockResolvedValue(undefined) };
  const controller = new WorkflowsController(workflowExposureService as never, workflowStreamService as never);
  return { controller, workflowExposureService, workflowStreamService };
}

const reflector = new Reflector();

describe('WorkflowsController', () => {
  describe.each([
    ['list', 'workflow:definition:read'],
    ['invoke', 'workflow:run:write'],
    ['getRunStatus', 'workflow:run:read'],
    ['cancelRun', 'workflow:run:write'],
    ['streamRunStatus', 'workflow:run:read'],
  ] as const)('%s', (method, expectedScope) => {
    it('carries an authorization decorator (REQUIRED_PERMISSIONS_KEY)', () => {
      const handler = (WorkflowsController.prototype as never as Record<string, () => void>)[method];
      const meta = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowsController]);
      expect(meta).toBeDefined();
      expect(meta!.length).toBeGreaterThan(0);
    });

    it(`carries @RequiredScopes('${expectedScope}')`, () => {
      const handler = (WorkflowsController.prototype as never as Record<string, () => void>)[method];
      const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [handler, WorkflowsController]);
      expect(scopes).toEqual([expectedScope]);
    });
  });

  it('GET / delegates to IWorkflowExposureService.list() verbatim', async () => {
    const { controller, workflowExposureService } = makeController();
    const result = await controller.list();
    expect(workflowExposureService.list).toHaveBeenCalledWith();
    expect(result).toEqual({ data: [] });
  });

  it('POST :slug/invoke forwards the Idempotency-Key header and the caller api-key id, never tenantId', async () => {
    const { controller, workflowExposureService } = makeController();
    const req = { apiKey: { id: 'key-1' } };

    await controller.invoke('discharge_summary', { input: { a: 1 } }, req as never, 'client-key-9');

    expect(workflowExposureService.invoke).toHaveBeenCalledWith('discharge_summary', { input: { a: 1 } }, { idempotencyKey: 'client-key-9', apiKeyId: 'key-1' });
  });

  it('POST :slug/invoke tolerates a JWT-authenticated caller (no req.apiKey)', async () => {
    const { controller, workflowExposureService } = makeController();
    const req = {};

    await controller.invoke('discharge_summary', { input: {} }, req as never, undefined);

    expect(workflowExposureService.invoke).toHaveBeenCalledWith('discharge_summary', { input: {} }, { idempotencyKey: undefined, apiKeyId: undefined });
  });

  it('GET :slug/runs/:runId delegates to getRunStatus(slug, runId)', async () => {
    const { controller, workflowExposureService } = makeController();
    await controller.getRunStatus('discharge_summary', 'run-1');
    expect(workflowExposureService.getRunStatus).toHaveBeenCalledWith('discharge_summary', 'run-1');
  });

  it('POST :slug/runs/:runId/cancel delegates to cancelRun(slug, runId) — no signal-name parameter exists on the handler at all', async () => {
    const { controller, workflowExposureService } = makeController();
    await controller.cancelRun('discharge_summary', 'run-1');
    expect(workflowExposureService.cancelRun).toHaveBeenCalledWith('discharge_summary', 'run-1');
    expect(controller.cancelRun.length).toBe(2);
  });

  it('GET :slug/runs/:runId/stream delegates to WorkflowStreamService.stream(slug, runId, res)', async () => {
    const { controller, workflowStreamService } = makeController();
    const res = {} as never;

    await controller.streamRunStatus('discharge_summary', 'run-1', res);

    expect(workflowStreamService.stream).toHaveBeenCalledWith('discharge_summary', 'run-1', res);
  });

  it('the stream route carries @StreamScope({ namespace: "workflow_run", param: "runId" })', () => {
    const meta = reflector.getAllAndOverride(STREAM_SCOPE_METADATA, [WorkflowsController.prototype.streamRunStatus, WorkflowsController]);
    expect(meta).toEqual({ namespace: 'workflow_run', param: 'runId' });
  });
});
