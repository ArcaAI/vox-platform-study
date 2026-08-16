/**
 * `workflow-run-event.ts` unit tests (TASK-722 Task 8).
 *
 * Proves the envelope this gateway synthesizes from a polled status snapshot
 * conforms to `@arcaai/async-contract`'s envelope shape (so a real consumer
 * — or `asyncEnvelopeProblems` itself — accepts it), that the event `type`
 * flips from `workflow.run.progress` to `workflow.run.completed` on a
 * terminal status, and that `idempotencyKey` is a pure function of
 * `(runId, status)` — a repeated poll reporting the SAME status reproduces
 * the SAME key.
 */
import { describe, it, expect } from 'vitest';
import { asyncEnvelopeProblems } from '@arcaai/async-contract';
import type { WorkflowRunStatusResponse } from '@arcaai/applications';
import { buildWorkflowRunEventEnvelope, formatSseFrame, isTerminalRunStatus } from '../workflow-run-event';

const RUNNING_STATUS: WorkflowRunStatusResponse = {
  runId: 'run-1',
  slug: 'discharge_summary',
  workflowVersionNumber: 3,
  status: 'RUNNING',
  stages: [{ stageIndex: 0 }],
  startedAt: '2026-08-16T00:00:00.000Z',
  endedAt: null,
};

describe('isTerminalRunStatus', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'])('%s is terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(true);
  });

  it.each(['RUNNING', 'PENDING', 'UNKNOWN'])('%s is not terminal', (status) => {
    expect(isTerminalRunStatus(status)).toBe(false);
  });
});

describe('buildWorkflowRunEventEnvelope', () => {
  it('conforms to the async-contract envelope shape (asyncEnvelopeProblems is empty)', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    expect(asyncEnvelopeProblems(envelope)).toEqual([]);
  });

  it('type is workflow.run.progress while the run is live', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    expect(envelope.type).toBe('workflow.run.progress');
  });

  it('type is workflow.run.completed on a terminal snapshot', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', { ...RUNNING_STATUS, status: 'COMPLETED', endedAt: '2026-08-16T00:05:00.000Z' });
    expect(envelope.type).toBe('workflow.run.completed');
  });

  it('idempotencyKey is a pure function of (runId, status) — repeated ticks reproduce the same key', () => {
    const first = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    const second = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toBe('wf:run:run-1:status:RUNNING');
  });

  it('idempotencyKey changes when the status changes', () => {
    const running = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    const completed = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', { ...RUNNING_STATUS, status: 'COMPLETED' });
    expect(running.idempotencyKey).not.toBe(completed.idempotencyKey);
  });

  it('correlationId is the runId; causationId is always null (a poll tick is not caused by a prior envelope)', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    expect(envelope.correlationId).toBe('run-1');
    expect(envelope.causationId).toBeNull();
  });

  it('payload carries the full status snapshot', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    expect(envelope.payload).toEqual({
      runId: 'run-1',
      slug: 'discharge_summary',
      workflowVersionNumber: 3,
      status: 'RUNNING',
      stages: [{ stageIndex: 0 }],
      startedAt: '2026-08-16T00:00:00.000Z',
      endedAt: null,
    });
  });
});

describe('formatSseFrame', () => {
  it('writes event/id/data lines terminated by a blank line', () => {
    const envelope = buildWorkflowRunEventEnvelope('11111111-1111-1111-1111-111111111111', RUNNING_STATUS);
    const frame = formatSseFrame(envelope);

    expect(frame).toMatch(/^event: workflow\.run\.progress\n/);
    expect(frame).toContain(`id: ${envelope.id}\n`);
    expect(frame).toContain(`data: ${JSON.stringify(envelope)}\n`);
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
