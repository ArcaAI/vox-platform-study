/**
 * TASK-890 L7 — the HUMAN-REVIEW half of the exposure plane.
 *
 * `core.humanReview` has had a durable child workflow and two interpreter routes since
 * TASK-864 (`/api/v1/internal/workflow-runs/{runId}/reviews/{nodeId}[:decide]`), reachable
 * only with the internal service token. Nothing on the tenant plane could read or release
 * one, so a graph that parked on a human parked forever unless an operator signalled Temporal
 * by hand. These two methods are the proxy — and every property they must hold is a property
 * about NOT trusting the caller:
 *
 *  * run ownership is proved through the SAME `getRun` lookup `getRunStatus` uses, so a
 *    foreign or wrong-slug `runId` is 404 (never 403, never a leak that the run exists);
 *  * `reviewerId` comes from CLS, never the body — a decision is an attribution;
 *  * a harness that cannot answer FAILS, it does not report "no review". `exists: false`
 *    means the interpreter told us there is no live child; an unreachable harness must not
 *    be able to spell the same thing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { WorkflowExposureService } from '../workflow-exposure.service';

const cls = { get: vi.fn(), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const definitions = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const harness = {
  startWorkflowRun: vi.fn(),
  getWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  getWorkflowRunReview: vi.fn(),
  decideWorkflowRunReview: vi.fn(),
};
const runs = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };

function service(): WorkflowExposureService {
  return new WorkflowExposureService(
    definitions as never,
    harness as never,
    runs as never,
    config as never,
    eventEmitter as never,
    cls as never,
  );
}

const OWNED_RUN = {
  id: 'row-1',
  tenantId: 'tenant-1',
  runId: 'run-1',
  workflowSlug: 'triage',
  workflowVersionId: 'ver-1',
  workflowVersionNumber: 2,
  sessionId: 'workflow-interpreter-run-1',
  resultRef: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    // `requestUserId` reads `cls.get('user')?.id` (BaseService) — the bound human, which an
    // API-key caller also carries. There is no separate `userId` key.
    if (key === 'user') return { id: 'user-9' };
    return undefined;
  });
  runs.getRun.mockResolvedValue(OWNED_RUN);
});

describe('getReview', () => {
  it('proves run ownership, then projects the interpreter state', async () => {
    harness.getWorkflowRunReview.mockResolvedValue({
      runId: 'run-1',
      nodeId: 'n_review',
      exists: true,
      phase: 'WAITING',
      escalations: 1,
      decided: false,
      decision: null,
    });

    const result = await service().getReview('triage', 'run-1', 'n_review');

    expect(runs.getRun).toHaveBeenCalledWith('tenant-1', 'run-1');
    expect(harness.getWorkflowRunReview).toHaveBeenCalledWith('run-1', 'n_review', 'tenant-1');
    expect(result).toEqual({ runId: 'run-1', nodeId: 'n_review', exists: true, phase: 'WAITING', escalations: 1, decided: false, decision: null });
  });

  it('answers exists:false with null state — the node has not been reached, or the child is gone', async () => {
    harness.getWorkflowRunReview.mockResolvedValue({ runId: 'run-1', nodeId: 'n_review', exists: false });

    const result = await service().getReview('triage', 'run-1', 'n_review');

    expect(result).toEqual({ runId: 'run-1', nodeId: 'n_review', exists: false, phase: null, escalations: null, decided: false, decision: null });
  });

  it('404s a run that belongs to another tenant — the lookup is tenant-scoped and never reaches the harness', async () => {
    runs.getRun.mockRejectedValue(new NotFoundException('not found'));

    await expect(service().getReview('triage', 'run-foreign', 'n_review')).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.getWorkflowRunReview).not.toHaveBeenCalled();
  });

  it("404s a runId that does not belong to the slug's lineage", async () => {
    runs.getRun.mockResolvedValue({ ...OWNED_RUN, workflowSlug: 'something_else' });

    await expect(service().getReview('triage', 'run-1', 'n_review')).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.getWorkflowRunReview).not.toHaveBeenCalled();
  });

  it('propagates a harness failure instead of reporting "no review"', async () => {
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', isAxiosError: true });
    harness.getWorkflowRunReview.mockRejectedValue(unreachable);

    await expect(service().getReview('triage', 'run-1', 'n_review')).rejects.toBe(unreachable);
  });

  it('throws when CLS carries no tenant', async () => {
    cls.get.mockReturnValue(undefined);
    await expect(service().getReview('triage', 'run-1', 'n_review')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('decideReview', () => {
  beforeEach(() => {
    harness.decideWorkflowRunReview.mockResolvedValue({ runId: 'run-1', nodeId: 'n_review', workflowId: 'run-1-review-n_review', signaled: true });
  });

  it('stamps reviewerId from CLS and forwards the decision verbatim', async () => {
    const result = await service().decideReview('triage', 'run-1', 'n_review', { decision: 'approved', comment: 'looks right' });

    expect(harness.decideWorkflowRunReview).toHaveBeenCalledWith(
      'run-1',
      'n_review',
      { decision: 'approved', reviewerId: 'user-9', comment: 'looks right', editedPayload: undefined },
      'tenant-1',
    );
    expect(result).toEqual({ runId: 'run-1', nodeId: 'n_review', decision: 'approved', signaled: true, reviewerId: 'user-9' });
  });

  it('never lets a body-supplied reviewerId reach the interpreter', async () => {
    await service().decideReview('triage', 'run-1', 'n_review', { decision: 'rejected', reviewerId: 'someone-else' } as never);

    expect(harness.decideWorkflowRunReview.mock.calls[0]![2]).toMatchObject({ reviewerId: 'user-9' });
  });

  it('forwards an editedPayload when the caller supplies one', async () => {
    await service().decideReview('triage', 'run-1', 'n_review', { decision: 'approved', editedPayload: { summary: 'fixed' } });

    expect(harness.decideWorkflowRunReview.mock.calls[0]![2]).toMatchObject({ editedPayload: { summary: 'fixed' } });
  });

  it('404s a foreign run before signalling anything', async () => {
    runs.getRun.mockRejectedValue(new NotFoundException('not found'));

    await expect(service().decideReview('triage', 'run-foreign', 'n_review', { decision: 'approved' })).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.decideWorkflowRunReview).not.toHaveBeenCalled();
  });

  it('broadcasts a ResourceUpdated sys-event for the decision', async () => {
    await service().decideReview('triage', 'run-1', 'n_review', { decision: 'rejected' });

    expect(eventEmitter.emit).toHaveBeenCalled();
    const emitted = eventEmitter.emit.mock.calls.at(-1)!;
    expect(JSON.stringify(emitted)).toContain('n_review');
  });

  it('propagates a harness failure rather than reporting a decision that reached nothing', async () => {
    const boom = Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503 } });
    harness.decideWorkflowRunReview.mockRejectedValue(boom);

    await expect(service().decideReview('triage', 'run-1', 'n_review', { decision: 'approved' })).rejects.toBe(boom);
  });
});
