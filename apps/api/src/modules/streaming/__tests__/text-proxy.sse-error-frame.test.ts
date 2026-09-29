import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { TextProxyController } from '../text-proxy.controller';

/**
 * A relay whose upstream dies mid-stream used to end the response cleanly, so
 * the client took a truncated generation for a finished one, and the log line
 * carried only `err.message` (no stack). It now logs the Error object with the
 * task id and writes a generic terminal `error` frame first.
 */

function makeResponse() {
  const written: string[] = [];
  const res = new EventEmitter() as any;
  res.written = written;
  res.setHeader = vi.fn();
  res.flushHeaders = vi.fn();
  res.write = vi.fn((chunk: Buffer | string) => {
    written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
  res.end = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn();
  res.writableEnded = false;
  res.headersSent = true;
  return res;
}

function build(overrides: { getObject?: unknown; mediaFindById?: unknown } = {}) {
  const upstream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  upstream.destroy = vi.fn();
  const http = { axiosRef: { get: vi.fn(async () => ({ data: upstream })), post: vi.fn() } };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };
  const ctrl = new TextProxyController(
    http as never,
    { fetchByCodeName: vi.fn() } as never,
    cls as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    (overrides.mediaFindById ?? { findById: vi.fn() }) as never,
    (overrides.getObject ?? { getObject: vi.fn() }) as never,
    { getConfigValue: vi.fn(() => 'http://text') } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordUsage: vi.fn().mockResolvedValue({ outboxIds: [], events: 0 }) } as never,
  );
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  (ctrl as unknown as { logger: typeof logger }).logger = logger;
  return { ctrl, upstream, logger };
}

describe('TextProxyController.streamTaskEvents — upstream stream error', () => {
  it('logs the Error object with the task id and tells the client the stream did not finish', async () => {
    const { ctrl, upstream, logger } = build();
    const res = makeResponse();

    await ctrl.streamTaskEvents('task-9', undefined, res as never);
    const socketError = new Error('socket hang up');
    upstream.emit('error', socketError);

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-9', error: socketError }));
    const frame = res.written.find((chunk: string) => chunk.startsWith('event: error'));
    expect(frame).toBeDefined();
    expect(frame).toContain('UPSTREAM_STREAM_ERROR');
    // Generic on purpose: no upstream text (possible PHI / prompt echo) reaches the client.
    expect(frame).not.toContain('socket hang up');
    expect(res.end).toHaveBeenCalled();
  });

  it('does not write into a response that has already ended', async () => {
    const { ctrl, upstream } = build();
    const res = makeResponse();

    await ctrl.streamTaskEvents('task-9', undefined, res as never);
    res.writableEnded = true;
    upstream.emit('error', new Error('late'));

    expect(res.written.some((chunk: string) => chunk.startsWith('event: error'))).toBe(false);
  });
});

describe('TextProxyController.extractAttachmentText — media lookup (documented non-fatal)', () => {
  it('a media row that does not exist is skipped without a lookup-failure warning', async () => {
    const { ctrl, logger } = build({ mediaFindById: { findById: vi.fn().mockRejectedValue(new DataNotFoundException('Media', 'm1')) } });

    await expect((ctrl as any).extractAttachmentText('m1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'Attachment media not found; skipping' }));
  });

  it('an outage is skipped too, but leaves a lookup-failure warn carrying the Error object', async () => {
    const outage = new Error('ECONNRESET');
    const { ctrl, logger } = build({ mediaFindById: { findById: vi.fn().mockRejectedValue(outage) } });

    await expect((ctrl as any).extractAttachmentText('m1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Attachment media lookup failed; skipping', error: outage, mediaId: 'm1' }),
    );
  });
});
