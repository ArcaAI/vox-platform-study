/**
 * `WorkflowStreamService` unit tests.
 *
 * **These tests changed shape with the transport .** They used to drive a poll
 * timer with fake timers and assert a fresh snapshot per tick. There is no poll timer any more:
 * the harness produces run events onto a Redis Stream and this service consumes them with a
 * blocking `XREAD`. What is asserted now is the client contract the ticket names —
 * snapshot-then-delta, `Last-Event-ID` resume with nothing lost, and a re-snapshot when the
 * cursor has aged out of the retained window — plus the properties that survived the rewrite
 * (ownership check before any header; no raw error forwarded; teardown on client close).
 *
 * The Redis fake is a real in-memory stream: monotonic ids, `XRANGE` for the oldest retained
 * entry, `XREAD` honouring an exclusive cursor. A mock that just returned canned rows could not
 * express a trim, which is the case the contract's fourth step exists for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { decodeResumeToken, encodeResumeToken } from '@arcaai/async-contract';
import { WorkflowStreamService, WORKFLOW_STREAM_BLOCK_MS, WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS, compareStreamIds } from '../workflow-stream.service';
import { RUN_EVENT_TRANSPORT, runEventStreamKey } from '../workflow-run-event';

function makeRunning(overrides: Record<string, unknown> = {}) {
  return { runId: 'run-1', slug: 'discharge_summary', workflowVersionNumber: 1, status: 'RUNNING', stages: [], startedAt: '2026-08-16T00:00:00.000Z', endedAt: null, ...overrides };
}

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-00000000000' + Math.floor(Math.random() * 10),
    tenantId: '22222222-2222-2222-2222-222222222222',
    type,
    occurredAt: '2026-09-01T00:00:00.000Z',
    correlationId: 'run-1',
    causationId: null,
    idempotencyKey: `wf:run:run-1:${type}:${JSON.stringify(payload)}`,
    payload,
  };
}

/** An in-memory Redis Stream: append, read-after-cursor, oldest-retained, and a trim. */
class FakeStreamRedis {
  private entries: [string, string[]][] = [];
  private sequence = 0;

  append(type: string, payload: Record<string, unknown> = {}): string {
    this.sequence += 1;
    const id = `${this.sequence}-0`;
    this.entries.push([id, ['data', JSON.stringify(envelope(type, payload))]]);
    return id;
  }

  /** Evict everything at or before `throughId` — what the producer's MAXLEN bound does. */
  trimThrough(throughId: string): void {
    this.entries = this.entries.filter(([id]) => compareStreamIds(id, throughId) > 0);
  }

  async xrange(_key: string, _min: string, _max: string, _count: string, _n: number) {
    return this.entries.length === 0 ? [] : [this.entries[0]];
  }

  /** Honours `BLOCK` rather than returning `null` instantly — a fake that returns immediately
   *  turns the service's read loop into a busy spin, which is a property of the FAKE, not of
   *  the code under test. */
  async xread(...args: unknown[]) {
    const blockMs = args[3] as number;
    const key = args[5] as string;
    const cursor = args[6] as string;
    const after = this.entries.filter(([id]) => compareStreamIds(id, cursor) > 0);
    if (after.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, blockMs));
      return null; // BLOCK expired with nothing new.
    }
    return [[key, after]];
  }

  async quit() {}
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

function makeService(getRunStatus: ReturnType<typeof vi.fn>, redis: FakeStreamRedis | null) {
  const cls = { get: vi.fn(() => 'tenant-1') };
  const config = { isRedisConfigured: () => redis !== null, getRedisConfig: () => ({ host: 'h', port: 1 }) };
  const service = new WorkflowStreamService({ getRunStatus } as never, cls as never, config as never);
  // Substitute the reader connection rather than a real socket. The consume loop under test is
  // the service's own, unmodified.
  (service as unknown as { readerRedis: unknown }).readerRedis = redis;
  return service;
}

/** Every `data:` line written, parsed back into an envelope. */
function framesOf(res: ReturnType<typeof makeRes>) {
  return res.write.mock.calls
    .map((call) => String(call[0]))
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => ({
      raw: frame,
      id: /\nid: (.+)\n/.exec(frame)?.[1],
      envelope: JSON.parse(/\ndata: (.+)\n\n$/.exec(frame)![1]),
    }));
}

describe('WorkflowStreamService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('runs the ownership check BEFORE writing any header — a 404 never leaks a 200 stream', async () => {
    const service = makeService(vi.fn().mockRejectedValue(new NotFoundException('not found')), new FakeStreamRedis());
    const res = makeRes();

    await expect(service.stream('discharge_summary', 'run-x', res as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('sets SSE headers, flushes, and writes the connect snapshot with NO id line', async () => {
    // No `id:` on the snapshot is the async-contract rule, not an omission: a snapshot is
    // not a stream position, and a token that cannot resume must never be minted.
    const redis = new FakeStreamRedis();
    redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
    const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    const [snapshot] = framesOf(res);
    expect(snapshot.envelope.type).toBe('workflow.run.progress');
    expect(snapshot.id).toBeUndefined();
  });

  it('ends immediately on a terminal first snapshot — the stream is never opened', async () => {
    const getRunStatus = vi.fn().mockResolvedValue(makeRunning({ status: 'COMPLETED' }));
    const redis = new FakeStreamRedis();
    const xread = vi.spyOn(redis, 'xread');
    const service = makeService(getRunStatus, redis);
    const res = makeRes();

    await service.stream('discharge_summary', 'run-1', res as never);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(getRunStatus).toHaveBeenCalledTimes(1);
    expect(xread).not.toHaveBeenCalled();
  });

  describe('the poll is gone', () => {
    it('reads the run status EXACTLY ONCE for a whole live run — the rest is pushed', async () => {
      // This is the ticket's first verification criterion, as a test. The old service called
      // `getRunStatus` on every 2s tick for the entire life of the run; it now calls it once,
      // for the snapshot, and learns everything else from the producer.
      const redis = new FakeStreamRedis();
      redis.append('workflow.node.started', { nodeId: 'n1' });
      redis.append('workflow.node.completed', { nodeId: 'n1', status: 'SUCCEEDED' });
      redis.append('workflow.node.started', { nodeId: 'n2' });
      redis.append('workflow.node.completed', { nodeId: 'n2', status: 'SUCCEEDED' });
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
      const getRunStatus = vi.fn().mockResolvedValue(makeRunning());
      const service = makeService(getRunStatus, redis);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never);

      expect(getRunStatus).toHaveBeenCalledTimes(1);
      expect(framesOf(res).map((f) => f.envelope.type)).toEqual([
        'workflow.run.progress',
        'workflow.node.started',
        'workflow.node.completed',
        'workflow.node.started',
        'workflow.node.completed',
        'workflow.run.completed',
      ]);
      expect(res.end).toHaveBeenCalled();
    });

    it('exports no poll interval any more', async () => {
      const module = await import('../workflow-stream.service');
      expect('WORKFLOW_STREAM_POLL_INTERVAL_MS' in module).toBe(false);
    });

    it('reads the run stream under the SAME key the producer writes', async () => {
      // Two spellings of one key is a stream that silently carries nothing, so the literal is
      // pinned here against `run_events.py`'s `run_event_stream_key`.
      expect(runEventStreamKey('run-1')).toBe('wf:run:run-1:events');
      const redis = new FakeStreamRedis();
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
      const xread = vi.spyOn(redis, 'xread');
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);

      await service.stream('discharge_summary', 'run-1', makeRes() as never);

      expect(xread.mock.calls[0][5]).toBe('wf:run:run-1:events');
    });
  });

  describe('resume', () => {
    it('every pushed frame carries an opaque resume token as its SSE id', async () => {
      const redis = new FakeStreamRedis();
      redis.append('workflow.node.started', { nodeId: 'n1' });
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never);

      const pushed = framesOf(res).slice(1);
      expect(pushed).toHaveLength(2);
      expect(decodeResumeToken(pushed[0].id!)).toEqual({ transport: RUN_EVENT_TRANSPORT, cursor: '1-0' });
      expect(decodeResumeToken(pushed[1].id!)).toEqual({ transport: RUN_EVENT_TRANSPORT, cursor: '2-0' });
    });

    it('a disconnect and reconnect with Last-Event-ID loses NOTHING', async () => {
      // The ticket's second verification criterion. One producer, two connections, and the union
      // of what the client received must equal what was produced — no gap, no duplicate.
      const redis = new FakeStreamRedis();
      redis.append('workflow.node.started', { nodeId: 'n1' });
      redis.append('workflow.node.completed', { nodeId: 'n1', status: 'SUCCEEDED' });
      const getRunStatus = vi.fn().mockResolvedValue(makeRunning());

      // Connection 1 — client drops after consuming what exists so far.
      const first = makeRes();
      const serviceA = makeService(getRunStatus, redis);
      const dropAfterTwo = new Promise<void>((resolve) => {
        let seen = 0;
        first.write.mockImplementation(() => {
          seen += 1;
          if (seen === 3) {
            (first as { writableEnded: boolean }).writableEnded = true;
            resolve();
          }
          return true;
        });
      });
      const streaming = serviceA.stream('discharge_summary', 'run-1', first as never);
      await dropAfterTwo;
      await streaming;

      const lastToken = encodeResumeToken(RUN_EVENT_TRANSPORT, '2-0');

      // Meanwhile the run continues and finishes.
      redis.append('workflow.node.started', { nodeId: 'n2' });
      redis.append('workflow.node.completed', { nodeId: 'n2', status: 'SUCCEEDED' });
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });

      // Connection 2 — resumes from the token.
      const second = makeRes();
      const serviceB = makeService(getRunStatus, redis);
      await serviceB.stream('discharge_summary', 'run-1', second as never, lastToken);

      const resumed = framesOf(second).slice(1); // drop the reconnect snapshot
      expect(resumed.map((f) => f.envelope.payload.nodeId ?? f.envelope.type)).toEqual(['n2', 'n2', 'workflow.run.completed']);
      // Nothing already delivered is re-sent: the cursor is exclusive.
      expect(resumed.map((f) => f.envelope.payload.nodeId)).not.toContain('n1');
    });

    it('a malformed or foreign-transport Last-Event-ID resyncs instead of failing the request', async () => {
      const redis = new FakeStreamRedis();
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never, 'not-a-token');

      expect(framesOf(res).map((f) => f.envelope.type)).toEqual(['workflow.run.progress', 'workflow.run.completed']);
    });

    it('re-snapshots when the cursor has been TRIMMED out of the retained window', async () => {
      // The contract's fourth step. Redis does not report an evicted cursor — an XREAD from one
      // returns the surviving tail with no error — so a client would otherwise be handed a hole
      // it cannot see. The honest answer is to resynchronise, and to say so with a snapshot.
      const redis = new FakeStreamRedis();
      redis.append('workflow.node.started', { nodeId: 'n1' });
      redis.append('workflow.node.completed', { nodeId: 'n1', status: 'SUCCEEDED' });
      redis.append('workflow.node.started', { nodeId: 'n2' });
      redis.append('workflow.run.completed', { status: 'SUCCEEDED' });
      redis.trimThrough('2-0'); // entries 1-0 and 2-0 are gone

      const getRunStatus = vi.fn().mockResolvedValue(makeRunning());
      const service = makeService(getRunStatus, redis);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never, encodeResumeToken(RUN_EVENT_TRANSPORT, '1-0'));

      const types = framesOf(res).map((f) => f.envelope.type);
      // Two snapshots: the connect one, then the resync that admits the gap.
      expect(types.filter((t) => t === 'workflow.run.progress')).toHaveLength(2);
      expect(getRunStatus).toHaveBeenCalledTimes(2);
      // And it then delivers everything still retained rather than skipping ahead.
      expect(types.slice(2)).toEqual(['workflow.node.started', 'workflow.run.completed']);
    });
  });

  describe('failure and teardown', () => {
    it('ends after the snapshot when Redis is unavailable — the client is never left hanging', async () => {
      const getRunStatus = vi.fn().mockResolvedValue(makeRunning());
      const service = makeService(getRunStatus, null);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never);

      expect(framesOf(res).map((f) => f.envelope.type)).toEqual(['workflow.run.progress']);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('ends the stream without forwarding the raw error when the read fails', async () => {
      const redis = new FakeStreamRedis();
      vi.spyOn(redis, 'xread').mockRejectedValue(new Error('stream no longer resolvable'));
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
      const res = makeRes();

      await service.stream('discharge_summary', 'run-1', res as never);

      expect(res.end).toHaveBeenCalledTimes(1);
      for (const call of res.write.mock.calls) {
        expect(String(call[0])).not.toContain('stream no longer resolvable');
      }
    });

    it('writes a heartbeat frame on its own cadence while the stream is idle', async () => {
      // An idle SSE connection must not look dead to an intervening proxy. The stream is idle
      // here for a real reason: the run has produced nothing yet, so `XREAD` is parked in its
      // BLOCK window — which is exactly when a heartbeat matters.
      vi.useFakeTimers();
      const redis = new FakeStreamRedis(); // empty: every read blocks
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
      const res = makeRes();

      const streaming = service.stream('discharge_summary', 'run-1', res as never);
      await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);
      expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');

      res.emit('close');
      await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_HEARTBEAT_INTERVAL_MS);
      await streaming;
      vi.useRealTimers();
    });

    it('client close tears the consume loop down', async () => {
      vi.useFakeTimers();
      const redis = new FakeStreamRedis();
      const xread = vi.spyOn(redis, 'xread');
      const service = makeService(vi.fn().mockResolvedValue(makeRunning()), redis);
      const res = makeRes();

      const streaming = service.stream('discharge_summary', 'run-1', res as never);
      // Let the snapshot resolve and the `close` listener register before disconnecting —
      // `stream()` awaits `getRunStatus` first, so a synchronous emit here would fire into a
      // listener list that does not exist yet and the test would hang on its own setup.
      await vi.advanceTimersByTimeAsync(0);
      res.emit('close');
      await vi.advanceTimersByTimeAsync(WORKFLOW_STREAM_BLOCK_MS + 1);
      await streaming;

      // Only the read already in flight when close landed — the loop did not re-arm.
      expect(xread.mock.calls.length).toBeLessThanOrEqual(1);
      expect(res.end).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('compareStreamIds', () => {
    it('orders ids numerically, not lexically', () => {
      // `"10-0" < "9-0"` as strings. A lexical comparison reports a phantom gap the first time
      // a stream crosses a digit boundary, which would re-snapshot every reconnect forever.
      expect(compareStreamIds('10-0', '9-0')).toBe(1);
      expect(compareStreamIds('9-0', '10-0')).toBe(-1);
      expect(compareStreamIds('5-2', '5-1')).toBe(1);
      expect(compareStreamIds('5-1', '5-1')).toBe(0);
    });
  });
});
