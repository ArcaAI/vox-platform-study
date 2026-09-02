/**
 * TASK-850 lane A — the invocation handler the four surfaces converge on.
 *
 * Covers the parts that live in the gateway rather than the application service:
 *
 *   * `POST /workflows/:slug/runs` — the canonical unbound entry (`/invoke` stays as a
 *     delegating alias, because the shipped SDK and the seeded examples call it);
 *   * `POST /consultations/:consultationId/workflows/:slug/runs` — the consultation-BOUND entry,
 *     whose id comes from the URL and nowhere else;
 *   * the three response modes, including the blocking ceiling → 504;
 *   * the durable-execution promise: a client disconnect never cancels the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayTimeoutException } from '@nestjs/common';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { WorkflowsController } from '../workflows.controller';
import { ConsultationWorkflowRunsController } from '../consultation-workflow-runs.controller';

const reflector = new Reflector();

function makeDeps() {
  const workflowExposureService = {
    list: vi.fn().mockResolvedValue({ data: [] }),
    invoke: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/x', streamUrl: '/x/stream' }),
    getRunStatus: vi
      .fn()
      .mockResolvedValue({ runId: 'run-1', slug: 's', workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null }),
    cancelRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' }),
  };
  const workflowStreamService = {
    stream: vi.fn().mockResolvedValue(undefined),
    awaitTerminal: vi.fn().mockResolvedValue({ runId: 'run-1', slug: 's', workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null }),
  };
  return { workflowExposureService, workflowStreamService };
}

const req = { apiKey: { id: 'key-1' } } as never;
const res = () =>
  ({ setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(), status: vi.fn(), writableEnded: false }) as never;

beforeEach(() => vi.clearAllMocks());

describe('TASK-850 — POST /workflows/:slug/runs is the canonical unbound entry', () => {
  it('delegates with no consultation binding at all', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await controller.startRun('discharge_summary', { input: { text: 'hi' } }, req, res(), undefined, 'idem-1');

    expect(deps.workflowExposureService.invoke).toHaveBeenCalledWith(
      'discharge_summary',
      { input: { text: 'hi' } },
      { idempotencyKey: 'idem-1', apiKeyId: 'key-1' },
    );
    // The absence is the point: nothing on this route can produce a consultation binding.
    expect(deps.workflowExposureService.invoke.mock.calls[0][2]).not.toHaveProperty('consultationId');
  });

  it('carries the deny-by-default ability and the workflow scope', () => {
    const handler = (WorkflowsController.prototype as never as Record<string, () => void>).startRun;
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowsController])).toBeDefined();
    expect(reflector.getAllAndOverride(API_KEY_REQUIRED_SCOPES, [handler, WorkflowsController])).toEqual(['workflow:run:write']);
  });

  it('keeps /invoke working as a delegating alias', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await controller.invoke('discharge_summary', { input: {} }, req, 'idem-2');

    expect(deps.workflowExposureService.invoke).toHaveBeenCalledWith('discharge_summary', { input: {} }, { idempotencyKey: 'idem-2', apiKeyId: 'key-1' });
  });
});

describe('TASK-850 — the consultation-bound entry takes its id from the URL', () => {
  it('passes the PATH consultationId through as the binding', async () => {
    const deps = makeDeps();
    const controller = new ConsultationWorkflowRunsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await controller.startRun('consult-1', 'consult_flow', { input: { note: 'x' } }, req, res(), undefined, undefined);

    expect(deps.workflowExposureService.invoke).toHaveBeenCalledWith(
      'consult_flow',
      { input: { note: 'x' } },
      expect.objectContaining({ consultationId: 'consult-1' }),
    );
  });

  it('lists with the consultation-bound catalogue, so discovery matches what it can invoke', async () => {
    const deps = makeDeps();
    const controller = new ConsultationWorkflowRunsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await controller.list('consult-1');

    expect(deps.workflowExposureService.list).toHaveBeenCalledWith({ consultationBound: true });
  });

  it('requires ConsultationWorkflow:execute and the separate workflows:execute scope', () => {
    const handler = (ConsultationWorkflowRunsController.prototype as never as Record<string, () => void>).startRun;
    const abilities = reflector.getAllAndOverride<{ action: string; subject: string }[]>(REQUIRED_PERMISSIONS_KEY, [
      handler,
      ConsultationWorkflowRunsController,
    ]);
    expect(abilities).toEqual(expect.arrayContaining([{ action: 'execute', subject: 'ConsultationWorkflow' }]));

    // A NEW top-level scope prefix on purpose: prefix matching means a key holding the bare
    // `workflow` scope grants every `workflow:*`. Consultation execution must not be inherited
    // that way — it has to be granted deliberately.
    const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [handler, ConsultationWorkflowRunsController]);
    expect(scopes).toEqual(['workflows:execute']);
    expect(scopes![0].startsWith('workflow:')).toBe(false);
  });
});

describe('TASK-850 — response modes', () => {
  it('async (the default) answers 202 with the run handle and never waits', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);
    const response = res();

    const body = await controller.startRun('discharge_summary', { input: {} }, req, response, undefined, undefined);

    expect(body).toMatchObject({ runId: 'run-1', status: 'started' });
    expect(deps.workflowStreamService.awaitTerminal).not.toHaveBeenCalled();
  });

  it('blocking waits on the SAME run-event transport and returns the terminal status', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    const body = await controller.startRun('discharge_summary', { input: {} }, req, res(), 'blocking', undefined);

    expect(deps.workflowStreamService.awaitTerminal).toHaveBeenCalledWith('discharge_summary', 'run-1', expect.any(Number));
    expect(body).toMatchObject({ status: 'COMPLETED' });
  });

  it('blocking hits its ceiling and 504s, telling the caller to switch to streaming', async () => {
    const deps = makeDeps();
    deps.workflowStreamService.awaitTerminal.mockResolvedValue(null); // ceiling reached, run still going
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await expect(controller.startRun('discharge_summary', { input: {} }, req, res(), 'blocking', undefined)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    await expect(controller.startRun('discharge_summary', { input: {} }, req, res(), 'blocking', undefined)).rejects.toThrow(/stream/i);
  });

  it('stream delegates to the TASK-849 stream — never a second one', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);
    const response = res();

    await controller.startRun('discharge_summary', { input: {} }, req, response, 'stream', undefined);

    expect(deps.workflowStreamService.stream).toHaveBeenCalledWith('discharge_summary', 'run-1', response, undefined);
  });
});

describe('TASK-850 — a client disconnect NEVER cancels the run', () => {
  it('does not cancel when the blocking wait ends at its ceiling', async () => {
    const deps = makeDeps();
    deps.workflowStreamService.awaitTerminal.mockResolvedValue(null);
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);

    await expect(controller.startRun('s', { input: {} }, req, res(), 'blocking', undefined)).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(deps.workflowExposureService.cancelRun).not.toHaveBeenCalled();
  });

  it('does not cancel when the streaming response closes', async () => {
    const deps = makeDeps();
    const controller = new WorkflowsController(deps.workflowExposureService as never, deps.workflowStreamService as never);
    const response = res();

    await controller.startRun('s', { input: {} }, req, response, 'stream', undefined);

    // The stream service wires `res.on('close')` to END WRITING, never to cancel. Nothing on
    // this path may reach the cancel signal — that is the durable-execution guarantee.
    expect(deps.workflowExposureService.cancelRun).not.toHaveBeenCalled();
  });
});
