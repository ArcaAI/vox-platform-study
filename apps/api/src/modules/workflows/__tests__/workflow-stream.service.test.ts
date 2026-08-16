/**
 * `WorkflowStreamService` unit tests (TASK-722 Task 8).
 *
 * Uses fake timers to drive the poll/heartbeat loop deterministically. Asserts:
 * the pre-stream ownership check runs BEFORE any header is written (a 404
 * never leaks a 200 stream); a snapshot is written on connect; polling stops
 * and the response ends on the first terminal snapshot; the heartbeat writes
 * `:keepalive\n\n` on its own cadence; a poll failure (ownership lost / upstream
 * error) ends the stream without forwarding the raw error; and client `close`
 * tears down both timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowStreamService, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS, WORKFLOW_STREAM_POLL_INTERVAL_MS } from '../workflow-stream.service';

function makeRunning(overrides: Record<string, unknown> = {}) {
  return { runId: 'run-1', slug: 'discharge_summary', workflowVersionNumber: 1, status: 'RUNNING', stages: [], startedAt: '2026-08-16T00:00:00.000Z', endedAt: null, ...overrides };
}

function makeRes() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
    writableEnded: false,
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  };
}

describe('WorkflowStreamService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the ownership check BEFORE writing any header — a 404 never leaks a 200 stream', async () => {
    const workflowExposureService = { getRunStatus: vi.fn().mockRejectedValue(new NotFoundException('not found')) };
    const cls = { get: vi.fn() };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await expect(service.stream('discharge_summary', 'run-x', res as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('sets SSE headers, flushes, and writes the first snapshot on connect', async () => {
    const workflowExposureService = { getRunStatus: vi.fn().mockResolvedValue(makeRunning()) };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write.mock.calls[0][0]).toContain('event: workflow.run.progress');
  });

  it('ends the stream immediately on a terminal first snapshot — no timers scheduled', async () => {
    const workflowExposureService = { getRunStatus: vi.fn().mockResolvedValue(makeRunning({ status: 'COMPLETED' })) };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(workflowExposureService.getRunStatus).toHaveBeenCalledTimes(1);

    // No poll timer was scheduled — advancing time triggers no further calls.
    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS * 3);
    expect(workflowExposureService.getRunStatus).toHaveBeenCalledTimes(1);
  });

  it('polls on WORKFLOW_STREAM_POLL_INTERVAL_MS and writes a fresh snapshot each tick until terminal', async () => {
    const workflowExposureService = {
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce(makeRunning())
        .mockResolvedValueOnce(makeRunning())
        .mockResolvedValueOnce(makeRunning({ status: 'COMPLETED', endedAt: '2026-08-16T00:05:00.000Z' })),
    };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);
    expect(res.write).toHaveBeenCalledTimes(1); // first (connect) snapshot

    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS);
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS);
    expect(res.write).toHaveBeenCalledTimes(3);
    expect(res.end).toHaveBeenCalledTimes(1);

    // The poll timer is cleared after the terminal tick — no further calls.
    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS * 3);
    expect(workflowExposureService.getRunStatus).toHaveBeenCalledTimes(3);
  });

  it('writes a heartbeat frame on its own cadence, independent of the poll interval', async () => {
    const workflowExposureService = { getRunStatus: vi.fn().mockResolvedValue(makeRunning()) };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);
    res.write.mockClear();

    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);
    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
  });

  it('ends the stream (without forwarding the raw error) when a later poll tick fails', async () => {
    const workflowExposureService = {
      getRunStatus: vi.fn().mockResolvedValueOnce(makeRunning()).mockRejectedValueOnce(new NotFoundException('run no longer resolvable')),
    };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);
    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS);

    expect(res.end).toHaveBeenCalledTimes(1);
    // The error itself is never written to the client stream.
    for (const call of res.write.mock.calls) {
      expect(String(call[0])).not.toContain('run no longer resolvable');
    }
  });

  it('client close tears down both the poll and heartbeat timers', async () => {
    const workflowExposureService = { getRunStatus: vi.fn().mockResolvedValue(makeRunning()) };
    const cls = { get: vi.fn(() => 'tenant-1') };
    const service = new WorkflowStreamService(workflowExposureService as never, cls as never);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);
    res.emit('close');

    await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_POLL_INTERVAL_MS * 5);
    // Only the initial connect-time call — the close tore the poll timer down.
    expect(workflowExposureService.getRunStatus).toHaveBeenCalledTimes(1);
  });
});
