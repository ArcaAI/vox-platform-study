/**
 * WorkflowSandboxRunController unit tests (TASK-721 Phase C).
 *
 * Asserts every mutating/read route carries an authorization decorator (deny-by-default boot
 * audit, rule 05), the controller carries `@RequiredScopes('admin:workflow-definition:manage')`
 * at the CLASS level (reused, not a new scope), the stream route carries
 * `@StreamScope({ namespace: 'workflow_run', param: 'runId' })` (the SAME namespace TASK-722
 * registered — no auth.controller.ts change needed), and that the controller is a thin
 * pass-through with zero business logic.
 */
import { describe, it, expect, vi } from 'vitest';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';
import { WorkflowSandboxRunController } from '../workflow-sandbox-run.controller';

function makeController() {
  const workflowSandboxRunService = {
    startRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/x', streamUrl: '/x/stream' }),
    getRunStatus: vi.fn().mockResolvedValue({ runId: 'run-1', workflowDefinitionId: 'def-1', status: 'RUNNING', stages: [], startedAt: null, endedAt: null }),
    cancelRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' }),
  };
  const workflowSandboxStreamService = { stream: vi.fn().mockResolvedValue(undefined) };
  const controller = new WorkflowSandboxRunController(workflowSandboxRunService as never, workflowSandboxStreamService as never);
  return { controller, workflowSandboxRunService, workflowSandboxStreamService };
}

const reflector = new Reflector();

describe('WorkflowSandboxRunController', () => {
  it('carries @RequiredScopes("admin:workflow-definition:manage") at the class level', () => {
    const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [WorkflowSandboxRunController]);
    expect(scopes).toEqual(['admin:workflow-definition:manage']);
  });

  describe.each([
    ['start', 'WorkflowRun'],
    ['getStatus', 'WorkflowRun'],
    ['cancel', 'WorkflowRun'],
    ['stream', 'WorkflowRun'],
  ] as const)('%s', (method, _subject) => {
    it('carries an authorization decorator (REQUIRED_PERMISSIONS_KEY)', () => {
      const handler = (WorkflowSandboxRunController.prototype as never as Record<string, () => void>)[method];
      const meta = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowSandboxRunController]);
      expect(meta).toBeDefined();
      expect(meta!.length).toBeGreaterThan(0);
    });
  });

  it('POST / delegates to startRun(definitionId, dto) verbatim', async () => {
    const { controller, workflowSandboxRunService } = makeController();
    await controller.start('def-1', { fixtureId: 'fixture-1' });
    expect(workflowSandboxRunService.startRun).toHaveBeenCalledWith('def-1', { fixtureId: 'fixture-1' });
  });

  it('GET :runId delegates to getRunStatus(definitionId, runId)', async () => {
    const { controller, workflowSandboxRunService } = makeController();
    await controller.getStatus('def-1', 'run-1');
    expect(workflowSandboxRunService.getRunStatus).toHaveBeenCalledWith('def-1', 'run-1');
  });

  it('POST :runId/cancel delegates to cancelRun(definitionId, runId) — no signal-name parameter exists on the handler at all', async () => {
    const { controller, workflowSandboxRunService } = makeController();
    await controller.cancel('def-1', 'run-1');
    expect(workflowSandboxRunService.cancelRun).toHaveBeenCalledWith('def-1', 'run-1');
    expect(controller.cancel.length).toBe(2);
  });

  it('GET :runId/stream delegates to WorkflowSandboxStreamService.stream(definitionId, runId, res)', async () => {
    const { controller, workflowSandboxStreamService } = makeController();
    const res = {} as never;
    await controller.stream('def-1', 'run-1', res);
    expect(workflowSandboxStreamService.stream).toHaveBeenCalledWith('def-1', 'run-1', res);
  });

  it('the stream route reuses the workflow_run:<runId> ticket namespace (TASK-722, no auth.controller.ts change needed)', () => {
    const meta = reflector.getAllAndOverride(STREAM_SCOPE_METADATA, [WorkflowSandboxRunController.prototype.stream, WorkflowSandboxRunController]);
    expect(meta).toEqual({ namespace: 'workflow_run', param: 'runId' });
  });
});
