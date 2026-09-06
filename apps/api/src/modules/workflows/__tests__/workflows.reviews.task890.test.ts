/**
 * TASK-890 L7 — the two human-review routes on `WorkflowsController`.
 *
 * `core.humanReview` had a durable wait and two INTERNAL interpreter routes since TASK-864,
 * and nothing on the tenant plane could reach them. These two routes are the proxy.
 *
 * What is asserted here is metadata and delegation, in the style
 * `workflows.controller.test.ts` already uses: every route carries BOTH an authorization
 * decorator (the deny-by-default boot audit, rule 05) AND `@RequiredScopes` (the independent
 * API-key gate), the controller stays a thin pass-through, and `reviewerId` is never a
 * parameter it could accept.
 */
import { describe, it, expect, vi } from 'vitest';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { WorkflowsController } from '../workflows.controller';

function makeController() {
  const workflowExposureService = {
    getReview: vi.fn().mockResolvedValue({ runId: 'run-1', nodeId: 'n_review', exists: true, phase: 'WAITING', escalations: 0, decided: false, decision: null }),
    decideReview: vi.fn().mockResolvedValue({ runId: 'run-1', nodeId: 'n_review', decision: 'approved', signaled: true, reviewerId: 'user-9' }),
  };
  const workflowStreamService = { stream: vi.fn() };
  const controller = new WorkflowsController(workflowExposureService as never, workflowStreamService as never);
  return { controller, workflowExposureService };
}

const reflector = new Reflector();
const handlerOf = (method: string) => (WorkflowsController.prototype as never as Record<string, () => void>)[method]!;

describe('WorkflowsController — human review', () => {
  describe.each([
    ['getReview', 'workflow:run:read'],
    ['decideReview', 'workflow:run:write'],
  ] as const)('%s', (method, expectedScope) => {
    it('carries an authorization decorator (REQUIRED_PERMISSIONS_KEY)', () => {
      const meta = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [handlerOf(method), WorkflowsController]);
      expect(meta).toBeDefined();
      expect(meta!.length).toBeGreaterThan(0);
    });

    it(`carries @RequiredScopes('${expectedScope}')`, () => {
      const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [handlerOf(method), WorkflowsController]);
      expect(scopes).toEqual([expectedScope]);
    });
  });

  it('reads the ability from the RUN, not the definition — a review is a run-scoped act', () => {
    const read = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [handlerOf('getReview'), WorkflowsController]);
    const write = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [handlerOf('decideReview'), WorkflowsController]);
    expect(read).toEqual([{ action: 'read', subject: 'WorkflowRun' }]);
    expect(write).toEqual([{ action: 'update', subject: 'WorkflowRun' }]);
  });

  it('GET …/reviews/:nodeId delegates to getReview(slug, runId, nodeId) verbatim', async () => {
    const { controller, workflowExposureService } = makeController();

    const result = await controller.getReview('triage', 'run-1', 'n_review');

    expect(workflowExposureService.getReview).toHaveBeenCalledWith('triage', 'run-1', 'n_review');
    expect(result).toMatchObject({ nodeId: 'n_review', exists: true });
  });

  it('POST …/reviews/:nodeId/decide delegates the body verbatim and passes NO reviewer identity', async () => {
    const { controller, workflowExposureService } = makeController();

    await controller.decideReview('triage', 'run-1', 'n_review', { decision: 'approved', comment: 'ok' });

    expect(workflowExposureService.decideReview).toHaveBeenCalledWith('triage', 'run-1', 'n_review', { decision: 'approved', comment: 'ok' });
    // The controller has no access to a reviewer id and must not acquire one: it is resolved
    // from CLS inside the service, so there is no parameter a caller could aim at.
    expect(controller.decideReview.length).toBe(4);
  });

  it('never accepts tenantId as a route parameter (S-3)', () => {
    expect(WorkflowsController.prototype.getReview.length).toBe(3);
  });
});
