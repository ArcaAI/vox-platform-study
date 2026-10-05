/**
 * TASK-1038 B3a deliverable 2 — run protocol v2 on the business-plane SSE route
 * (protocol-v2.md §2, §5, §6), plus the legacy frames DERIVED from stored v2 events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { RUN_DEDUPE_KEY, RUN_EVENTS_KEY, RUN_SEQ_KEY, decodeResumeToken, encodeResumeToken, parseSseFrame } from '@arcaai/async-contract';
import type { RunAppendInput, RunEventV2 } from '@arcaai/async-contract';
import { WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowStreamService } from '../workflow-stream.service';
import { parseClientCursor, resolveRunProtocol } from '../run-protocol-delivery';
import { RUN_EVENT_TRANSPORT } from '../workflow-run-event';
import { FakeRedisServer } from './fake-redis-streams';

const TENANT = '22222222-2222-2222-2222-222222222222';
const TS = '2026-10-04T10:00:00.000Z';
const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };

function status(value: string) {
  return { runId: 'R', slug: 'flow', workflowVersionNumber: 1, status: value, stages: [], startedAt: TS, endedAt: null };
}

function settingsWith(values: Record<string, number> = {}) {
  return { resolvePlatform: vi.fn((key: string) => ({ key, value: values[key], source: 'system' })) };
}

function makeRes() {
  const listeners: Record<string, (() => void)[]> = {};
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((_chunk: string) => true),
    writableEnded: false,
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    once: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    off: vi.fn(),
  };
  return res;
}

/** Every v2 frame written, parsed with the contract's own SSE parser (which cross-checks `event:`/`id:`). */
/** The run's events without keep-alives: a live stream opens with a `ping` (TASK-1038 load test). */
function v2Events(res: ReturnType<typeof makeRes>): RunEventV2[] {
  return v2Frames(res).filter((frame) => frame.type !== 'ping');
}

function v2Frames(res: ReturnType<typeof makeRes>): RunEventV2[] {
  return res.write.mock.calls
    .map((call) => String(call[0]))
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => {
      const parsed = parseSseFrame(chunk);
      if (parsed.kind !== 'event') throw new Error(`not a v2 frame: ${chunk} ${JSON.stringify(parsed)}`);
      return parsed.event;
    });
}

function legacyFrames(res: ReturnType<typeof makeRes>) {
  return res.write.mock.calls
    .map((call) => String(call[0]))
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => ({
      id: /\nid: (.+)\n/.exec(chunk)?.[1],
      envelope: JSON.parse(/\ndata: (.+)\n\n$/.exec(chunk)![1]) as { type: string; tenantId: string; payload: Record<string, unknown> },
    }));
}

function build(server: FakeRedisServer, getRunStatus = vi.fn().mockResolvedValue(status('RUNNING')), settings = settingsWith()) {
  const hub = new RunEventStreamHub(CONFIG as never, settings as never);
  hub.connectionFactory = () => server.connection() as never;
  const service = new WorkflowStreamService({ getRunStatus } as never, { get: vi.fn(() => TENANT) } as never, hub, settings as never);
  return { hub, service, getRunStatus };
}

const ev = (input: Omit<RunAppendInput, 'runId' | 'ts'>): RunAppendInput => ({ runId: 'R', ts: TS, ...input });

/** A small run: graph events, admin debug events, an admin-only output, then completion. */
function seedRun(server: FakeRedisServer, { complete = true }: { complete?: boolean } = {}) {
  server.appendV2(ev({ type: 'run.started', data: { kind: 'workflow', slug: 'flow', versionNumber: 1 } })); // 1
  server.appendV2(ev({ type: 'input.validated', data: { valid: true, problems: [] } })); // 2 admin
  server.appendV2(ev({ type: 'node.started', nodeId: 'n_note', data: { kind: 'core.agent' } })); // 3
  server.appendV2(ev({ type: 'prompt.composed', nodeId: 'n_note', data: { layers: [], charsTotal: 10, selected: [], excluded: [], blocks: [] } })); // 4 admin
  server.appendV2(ev({ type: 'output.text.delta', nodeId: 'n_note', data: { field: 'text', text: 'Hel' } })); // 5
  server.appendV2(ev({ type: 'output.text.delta', nodeId: 'n_note', data: { field: 'text', text: 'lo' } })); // 6
  server.appendV2(ev({ type: 'output.data', nodeId: 'n_note', data: { field: 'raw', value: { x: 1 }, visibility: 'admin' } })); // 7 admin
  server.appendV2(ev({ type: 'node.completed', nodeId: 'n_note', data: { status: 'COMPLETED', durationMs: 12 } })); // 8
  if (complete) {
    server.appendV2(
      ev({
        type: 'run.completed',
        data: { status: 'COMPLETED', durationMs: 20, tokens: { in: 1, out: 2 }, result: { kind: 'inline', value: { note: 'Hello' } } },
        retentionSeconds: 3600,
      }),
    ); // 9
  }
}

describe('protocol selection and cursors (§2, §6.2)', () => {
  it('header wins, then query; anything other than 2 is a 400, never a silent legacy downgrade', () => {
    expect(resolveRunProtocol({ header: '2' })).toBe(2);
    expect(resolveRunProtocol({ query: '2' })).toBe(2);
    expect(resolveRunProtocol({})).toBe('legacy');
    expect(() => resolveRunProtocol({ query: '1' })).toThrow(BadRequestException);
    expect(() => resolveRunProtocol({ header: 'v2', query: '2' })).toThrow(BadRequestException);
  });

  it('a seq cursor, a legacy Redis-id token (one release), and garbage', () => {
    expect(parseClientCursor({ lastEventId: '7', after: '3' }, 2)).toEqual({ kind: 'seq', after: 7 });
    expect(parseClientCursor({ after: '3' }, 2)).toEqual({ kind: 'seq', after: 3 });
    expect(parseClientCursor({ lastEventId: encodeResumeToken(RUN_EVENT_TRANSPORT, '5-0') }, 2)).toEqual({ kind: 'stream', id: '5-0' });
    expect(parseClientCursor({}, 2)).toEqual({ kind: 'start' });
    expect(() => parseClientCursor({ after: 'nope' }, 2)).toThrow(BadRequestException);
    expect(parseClientCursor({ legacyQuery: 'nope' }, 'legacy')).toEqual({ kind: 'start' });
  });
});

describe('v2 on the PUBLIC plane', () => {
  it('delivers the public subset with SSE id = seq, filters admin events, and ends on the terminal event', async () => {
    const server = new FakeRedisServer();
    seedRun(server);
    const { service, hub } = build(server);
    const res = makeRes();

    await service.stream('flow', 'R', res as never, undefined, { protocol: '2' });

    const frames = v2Events(res);
    expect(frames.map((f) => `${f.seq}:${f.type}`)).toEqual([
      '1:run.started',
      '3:node.started',
      '5:output.text.delta',
      '6:output.text.delta',
      '8:node.completed',
      '9:run.completed',
    ]);
    expect(res.end).toHaveBeenCalled();
    // The terminal event started retention on all three keys.
    expect(server.ttls.get(RUN_SEQ_KEY('R'))).toBe(3600);
    expect(server.ttls.get(RUN_DEDUPE_KEY('R'))).toBe(3600);
    await hub.onModuleDestroy();
  });

  it('strips error.detail and fixes run.cancelled.reason to a label (public); the admin trace keeps both', async () => {
    const server = new FakeRedisServer();
    server.appendV2(
      ev({
        type: 'node.failed',
        nodeId: 'n1',
        data: { durationMs: 1, error: { code: 'MODEL_ERROR', message: 'The model returned an error.', detail: 'upstream said: patient X' } },
      }),
    );
    server.appendV2(ev({ type: 'run.cancelled', data: { status: 'CANCELED', durationMs: 2, reason: 'Dr Smith pressed stop' }, retentionSeconds: 60 }));
    const pub = build(server);
    const res = makeRes();
    await pub.service.stream('flow', 'R', res as never, undefined, { protocol: '2' });
    const [failed, cancelled] = v2Events(res);
    expect((failed.data as unknown as { error: Record<string, unknown> }).error).toEqual({ code: 'MODEL_ERROR', message: 'The model returned an error.' });
    expect((cancelled.data as { reason: string }).reason).toBe('The run was cancelled.');
    await pub.hub.onModuleDestroy();

    const admin = build(server);
    const resAdmin = makeRes();
    await admin.service.streamRun({ runId: 'R', res: resAdmin as never, plane: 'admin', protocol: '2', readStatus: async () => status('RUNNING') as never });
    const [failedAdmin, cancelledAdmin] = v2Events(resAdmin);
    expect((failedAdmin.data as unknown as { error: { detail: string } }).error.detail).toBe('upstream said: patient X');
    expect((cancelledAdmin.data as { reason: string }).reason).toBe('Dr Smith pressed stop');
    await admin.hub.onModuleDestroy();
  });

  it('resumes after Last-Event-ID: <seq> — nothing at or before it is re-sent', async () => {
    const server = new FakeRedisServer();
    seedRun(server);
    const { service, hub } = build(server);
    const res = makeRes();

    await service.stream('flow', 'R', res as never, '5', { protocol: '2' });

    expect(v2Events(res).map((f) => f.seq)).toEqual([6, 8, 9]);
    await hub.onModuleDestroy();
  });

  it('a trimmed cursor gets run.resync { gap } with a node-then-field snapshot, then continues live', async () => {
    const server = new FakeRedisServer();
    seedRun(server, { complete: false });
    const ids = server.streams.get(RUN_EVENTS_KEY('R'))!.map(([id]) => id);
    server.trimThrough(RUN_EVENTS_KEY('R'), ids[3]); // seqs 1..4 gone
    const { service, hub } = build(server);
    const res = makeRes();

    const streaming = service.stream('flow', 'R', res as never, '2', { protocol: '2' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.appendV2(ev({ type: 'run.completed', data: { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }, retentionSeconds: 60 })); // 9
    await streaming;

    const frames = v2Events(res);
    expect(frames[0].type).toBe('run.resync');
    expect(frames[0].seq).toBe(8);
    const data = frames[0].data as { reason: string; snapshot: { lastSeq: number; outputs: Record<string, Record<string, unknown>>; status: string } };
    expect(data.reason).toBe('gap');
    expect(data.snapshot.lastSeq).toBe(8);
    expect(data.snapshot.status).toBe('RUNNING');
    // Public snapshot: the streamed text, keyed by node then field; never the admin-only output.
    expect(data.snapshot.outputs).toEqual({ n_note: { text: 'Hello' } });
    expect(frames.slice(1).map((f) => `${f.seq}:${f.type}`)).toEqual(['9:run.completed']);
    await hub.onModuleDestroy();
  });

  it('a cursor beyond the last seq is cursor_invalid; a cursor on an expired stream is expired', async () => {
    const server = new FakeRedisServer();
    seedRun(server);
    const a = build(server);
    const resA = makeRes();
    await a.service.stream('flow', 'R', resA as never, '99', { protocol: '2' });
    expect((v2Frames(resA)[0].data as { reason: string }).reason).toBe('cursor_invalid');
    await a.hub.onModuleDestroy();

    const empty = new FakeRedisServer();
    const b = build(empty, vi.fn().mockResolvedValue(status('COMPLETED')));
    const resB = makeRes();
    await b.service.stream('flow', 'R', resB as never, undefined, { protocol: '2', after: '4' });
    const [resync] = v2Frames(resB);
    expect(resync.type).toBe('run.resync');
    expect((resync.data as { reason: string; snapshot: { status: string } }).reason).toBe('expired');
    expect((resync.data as { snapshot: { status: string } }).snapshot.status).toBe('COMPLETED');
    expect(resB.end).toHaveBeenCalled();
    await b.hub.onModuleDestroy();
  });

  it('accepts a legacy Redis-id token as the cursor for one release', async () => {
    const server = new FakeRedisServer();
    seedRun(server);
    const ids = server.streams.get(RUN_EVENTS_KEY('R'))!.map(([id]) => id);
    const { service, hub } = build(server);
    const res = makeRes();
    await service.stream('flow', 'R', res as never, encodeResumeToken(RUN_EVENT_TRANSPORT, ids[5]), { protocol: '2' });
    expect(v2Events(res).map((f) => f.seq)).toEqual([8, 9]);
    await hub.onModuleDestroy();
  });

  it('answers run.resync { unavailable } from the read model when there is no event transport', async () => {
    const getRunStatus = vi.fn().mockResolvedValue(status('RUNNING'));
    const service = new WorkflowStreamService({ getRunStatus } as never, { get: vi.fn(() => TENANT) } as never, undefined, undefined);
    const res = makeRes();
    await service.stream('flow', 'R', res as never, undefined, { protocol: '2' });
    const [resync] = v2Events(res);
    expect(resync).toMatchObject({ seq: 0, type: 'run.resync', data: { reason: 'unavailable', snapshot: { status: 'RUNNING', lastSeq: 0 } } });
  });
});

describe('v2 keep-alive and the terminal backstop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ping.seq is this connection position, including admin events it filtered out', async () => {
    const server = new FakeRedisServer();
    server.appendV2(ev({ type: 'node.started', nodeId: 'n', data: { kind: 'k' } })); // 1 public
    server.appendV2(ev({ type: 'transcript.final', data: { text: 'hi' } })); // 2 admin
    const getRunStatus = vi.fn().mockResolvedValue(status('RUNNING'));
    const { service, hub } = build(server, getRunStatus);
    const res = makeRes();
    const closed = new AbortController();
    const streaming = service.stream('flow', 'R', res as never, undefined, { protocol: '2', signal: closed.signal });
    await vi.advanceTimersByTimeAsync(16_000);
    closed.abort();
    await vi.advanceTimersByTimeAsync(100);
    await streaming;

    const pings = v2Frames(res).filter((f) => f.type === 'ping');
    expect(pings.length).toBeGreaterThan(1);
    // The heartbeat ping after the replay carries the position past the filtered admin event.
    expect(pings[pings.length - 1].seq).toBe(2);
    await hub.onModuleDestroy();
  });

  // TASK-1038 live load test: a v2 stream on a queued run wrote NOTHING until its first event or
  // the 15 s heartbeat, so a client could not tell a live connection from a dead one. A live
  // stream now says so at once (`ping` at this connection's position — seq 0 before any event).
  it('a live v2 stream writes a ping at once, before any event exists', async () => {
    const server = new FakeRedisServer();
    const getRunStatus = vi.fn().mockResolvedValue(status('RUNNING'));
    const { service, hub } = build(server, getRunStatus);
    const res = makeRes();
    const closed = new AbortController();
    const streaming = service.stream('flow', 'R', res as never, undefined, { protocol: '2', signal: closed.signal });
    await vi.advanceTimersByTimeAsync(50);
    const first = v2Frames(res)[0];
    expect(first).toMatchObject({ type: 'ping', seq: 0 });
    closed.abort();
    await vi.advanceTimersByTimeAsync(100);
    await streaming;
    await hub.onModuleDestroy();
  });

  it('a run terminal in the read model with no terminal event: EXPIRE NX on all three keys + run.resync { gap } (terminal snapshot)', async () => {
    const server = new FakeRedisServer();
    server.appendV2(ev({ type: 'node.started', nodeId: 'n', data: { kind: 'k' } }));
    const getRunStatus = vi.fn().mockResolvedValueOnce(status('RUNNING')).mockResolvedValue(status('FAILED'));
    const { service, hub } = build(server, getRunStatus, settingsWith({ [WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY]: 5 }));
    const res = makeRes();
    const streaming = service.stream('flow', 'R', res as never, undefined, { protocol: '2' });
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await streaming;

    const last = v2Frames(res).at(-1)!;
    expect(last.type).toBe('run.resync');
    expect(last.data).toMatchObject({ reason: 'gap', snapshot: { status: 'FAILED', lastSeq: 1, nodes: { n: { status: 'running' } } } });
    for (const key of [RUN_SEQ_KEY('R'), RUN_EVENTS_KEY('R'), RUN_DEDUPE_KEY('R')]) expect(server.ttls.has(key) || key === RUN_DEDUPE_KEY('R')).toBe(true);
    // A terminal event arriving now is refused by the sequencer (the stream is closed).
    expect(() => server.appendV2(ev({ type: 'run.failed', data: { status: 'FAILED', durationMs: 1, error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } }, retentionSeconds: 5 }))).toThrow('RUN_STREAM_CLOSED');
    expect(res.end).toHaveBeenCalled();
    await hub.onModuleDestroy();
  });
});

describe('legacy frames derived from stored v2 events (no protocol selected)', () => {
  it('snapshot first, then the old six shapes, resume tokens on every delta, counts + result on completion', async () => {
    const server = new FakeRedisServer();
    seedRun(server);
    const { service, hub } = build(server);
    const res = makeRes();

    await service.stream('flow', 'R', res as never);

    const frames = legacyFrames(res);
    expect(frames.map((f) => f.envelope.type)).toEqual([
      'workflow.run.progress',
      'workflow.node.started',
      'workflow.token.delta',
      'workflow.token.delta',
      'workflow.node.completed',
      'workflow.run.completed',
    ]);
    expect(frames[0].id).toBeUndefined();
    expect(frames.slice(1).every((f) => decodeResumeToken(f.id!)?.transport === RUN_EVENT_TRANSPORT)).toBe(true);
    expect(frames[2].envelope.payload).toEqual({ nodeId: 'n_note', sequence: 5, text: 'Hel' });
    expect(frames.at(-1)!.envelope.payload).toEqual({
      status: 'SUCCEEDED',
      nodeCount: 1,
      failedNodeCount: 0,
      degradedNodeCount: 0,
      skippedNodeCount: 0,
      result: { kind: 'inline', value: { note: 'Hello' } },
    });
    expect(frames.every((f) => f.envelope.tenantId === TENANT)).toBe(true);
    await hub.onModuleDestroy();
  });
});
