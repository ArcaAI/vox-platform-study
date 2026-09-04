import { AiUsageUnit } from '@arcaai/domains';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextProxyController } from '../text-proxy.controller';

/**
 * The SSE proxy meters what flows through it.
 *
 * The proxy is a byte pipe: TEXT generates, the browser reads, and nothing in
 * between ever knew how many tokens were spent. This is also the path where the
 * Bug class lives — a stream that dies late loses its tail, and
 * with it every token the provider is about to bill for. So the abort case is
 * asserted alongside the happy one, and both must produce the SAME idempotency
 * key: a stream that aborts and then also runs teardown would otherwise bill
 * twice.
 */

const USAGE = {
  task_id: 'text-task-9',
  request_id: 'corr-9',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  endpoint_kind: 'anthropic.messages',
  interrupted: false,
  byok: false,
  occurred_at: '2026-08-06T10:00:00.000Z',
  prompt_tokens: 200,
  completion_tokens: 90,
  total_tokens: 290,
  raw: { input_tokens: 200, output_tokens: 90, cache_read_input_tokens: 1800 },
};

function sseFrame(event: string, data: unknown, id = '1-0'): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;
}

/** A fake express response that records nothing but the lifecycle we drive. */
function makeResponse() {
  const res = new EventEmitter() as unknown as {
    setHeader: ReturnType<typeof vi.fn>;
    flushHeaders: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    writableEnded: boolean;
    headersSent: boolean;
    on: EventEmitter['on'];
    emit: EventEmitter['emit'];
  };
  res.setHeader = vi.fn();
  res.flushHeaders = vi.fn();
  res.write = vi.fn();
  res.end = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn();
  res.writableEnded = false;
  res.headersSent = true;
  return res;
}

function build(usageLedger?: unknown) {
  const upstream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  upstream.destroy = vi.fn();

  const http = { axiosRef: { get: vi.fn(async () => ({ data: upstream })), post: vi.fn() } };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };
  const config = { getConfigValue: vi.fn(() => 'http://text') };

  const ctrl = new TextProxyController(
    http as never,
    { fetchByCodeName: vi.fn() } as never,
    cls as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { getObject: vi.fn() } as never,
    config as never,
    undefined, // secretsService
    undefined, // harnessPolicyService
    undefined, // aiModelService
    undefined, // aiTaskDefaultService
    undefined, // aiProviderConnectionService
    (usageLedger ?? { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) }) as never,
  );

  return { ctrl, upstream, http, ledger: (usageLedger ?? undefined) as { recordUsage: ReturnType<typeof vi.fn> } | undefined };
}

describe('TEXT proxy — ledger emission on stream teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits token rows when the stream completes normally', async () => {
    const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    upstream.emit('data', Buffer.from(sseFrame('chunk', { type: 'chunk', content: 'hi' })));
    upstream.emit('data', Buffer.from(sseFrame('done', { type: 'done', data: { finish_reason: 'stop', usage: USAGE } })));
    upstream.emit('end');
    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalled());

    const [input] = ledger.recordUsage.mock.calls[0];
    expect(input.common.operation).toBe('generate.stream');
    expect(input.common.idempotencyKey).toBe('llm:text-task-9');
    expect(input.common.tenantId).toBe('tenant-1');
    expect(input.common.provider).toBe('anthropic');
    expect(input.common.attributesJson).toMatchObject({ interrupted: false });
    // Anthropic input is EXCLUSIVE of cache — 200 uncached + 1800 cache-read.
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 200 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 90 },
      { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: 1800 },
    ]);
  });

  it('emits the tokens already burned when the client hangs up mid-stream', async () => {
    const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    upstream.emit('data', Buffer.from(sseFrame('error', { type: 'error', data: { error: 'boom', usage: { ...USAGE, interrupted: true } } })));
    res.emit('close');
    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalled());

    const [input] = ledger.recordUsage.mock.calls[0];
    // The SAME key a clean completion would use — an `...:aborted` variant
    // would bill the generation twice.
    expect(input.common.idempotencyKey).toBe('llm:text-task-9');
    expect(input.common.attributesJson).toMatchObject({ interrupted: true });
  });

  it('emits exactly once when the stream both errors and tears down', async () => {
    const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    upstream.emit('data', Buffer.from(sseFrame('done', { type: 'done', data: { finish_reason: 'stop', usage: USAGE } })));
    upstream.emit('end');
    upstream.emit('error', new Error('late socket error'));
    res.emit('close');
    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalledTimes(1));
  });

  it('handles a terminal frame split across two TCP chunks', async () => {
    const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    const frame = sseFrame('done', { type: 'done', data: { finish_reason: 'stop', usage: USAGE } });
    const split = Math.floor(frame.length / 2);
    upstream.emit('data', Buffer.from(frame.slice(0, split)));
    upstream.emit('data', Buffer.from(frame.slice(split)));
    upstream.emit('end');

    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalled());
  });

  it('emits nothing when the stream carried no usage block', async () => {
    const ledger = { recordUsage: vi.fn() };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    upstream.emit('data', Buffer.from(sseFrame('done', { type: 'done', data: { finish_reason: 'stop' } })));
    upstream.emit('end');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });

  it('never lets a metering failure break the stream', async () => {
    const ledger = { recordUsage: vi.fn().mockRejectedValue(new Error('outbox down')) };
    const { ctrl, upstream } = build(ledger);
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    upstream.emit('data', Buffer.from(sseFrame('done', { type: 'done', data: { finish_reason: 'stop', usage: USAGE } })));
    upstream.emit('end');
    await vi.waitFor(() => expect(ledger.recordUsage).toHaveBeenCalled());

    expect(res.end).toHaveBeenCalled();
  });

  it('forwards every byte unchanged — parsing must not disturb the pipe', async () => {
    const { ctrl, upstream } = build();
    const res = makeResponse();

    await ctrl.streamTaskEvents('text-task-9', undefined, res as never);

    const payload = Buffer.from(sseFrame('chunk', { type: 'chunk', content: 'hello' }));
    upstream.emit('data', payload);

    expect(res.write).toHaveBeenCalledWith(payload);
  });
});
