/**
 * TASK-1038 R6 — run protocol v2 (`../run-protocol`), held to the cross-language fixture
 * `tests/contracts/run-protocol.fixture.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_RUN_EVENT_TYPES,
  PUBLIC_RUN_EVENT_TYPES,
  RUN_EVENT_NODE_SCOPE,
  RUN_EVENT_TYPES,
  RUN_EVENT_VISIBILITY,
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_VERSION,
  RUN_RESULT_INLINE_MAX_BYTES,
  RUN_RESYNC_REASONS,
  advanceRunCursor,
  isPublicRunEvent,
  parseResumeCursor,
  parseRunEvent,
  parseSseFrame,
  runEventProblems,
  toSseFrame,
  type RunEventV2,
} from '../run-protocol';

interface Fixture {
  protocolVersion: number;
  header: string;
  inlineResultMaxBytes: number;
  visibility: Record<string, string>;
  nodeScope: Record<string, string>;
  examples: Array<{ name: string; event: RunEventV2 }>;
  invalid: Array<{ name: string; event: unknown; problem: string }>;
  sse: Array<{ name: string; event: RunEventV2; frame: string }>;
}

// __dirname, not import.meta.url: this package's tests compile to CommonJS (see envelope.test.ts).
const fixture = JSON.parse(readFileSync(join(__dirname, '../../../../tests/contracts/run-protocol.fixture.json'), 'utf-8')) as Fixture;

describe('run protocol v2 — constants agree with the fixture', () => {
  it('version, header and the inline-result cap', () => {
    expect(RUN_PROTOCOL_VERSION).toBe(fixture.protocolVersion);
    expect(RUN_PROTOCOL_HEADER).toBe(fixture.header);
    expect(RUN_RESULT_INLINE_MAX_BYTES).toBe(fixture.inlineResultMaxBytes);
  });

  it('the catalogue is the public subset plus the admin debug events, disjoint', () => {
    expect([...RUN_EVENT_TYPES]).toEqual([...PUBLIC_RUN_EVENT_TYPES, ...ADMIN_RUN_EVENT_TYPES]);
    expect(new Set(RUN_EVENT_TYPES).size).toBe(RUN_EVENT_TYPES.length);
    expect([...PUBLIC_RUN_EVENT_TYPES]).toEqual([
      'run.started',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'run.resync',
      'node.started',
      'node.completed',
      'node.failed',
      'output.text.delta',
      'output.audio.delta',
      'output.data',
      'ping',
    ]);
  });

  it('visibility and node scope match the fixture', () => {
    expect(RUN_EVENT_VISIBILITY).toEqual(fixture.visibility);
    expect(RUN_EVENT_NODE_SCOPE).toEqual(fixture.nodeScope);
    for (const type of PUBLIC_RUN_EVENT_TYPES) expect(isPublicRunEvent(type)).toBe(true);
    for (const type of ADMIN_RUN_EVENT_TYPES) expect(isPublicRunEvent(type)).toBe(false);
  });
});

describe('every example validates; every type has one', () => {
  it('covers the whole catalogue', () => {
    const covered = new Set(fixture.examples.map((entry) => entry.event.type));
    for (const type of RUN_EVENT_TYPES) expect(covered.has(type), type).toBe(true);
  });

  it.each(fixture.examples.map((entry) => [entry.name, entry.event] as const))('%s', (_name, event) => {
    expect(runEventProblems(event)).toEqual([]);
    expect(parseRunEvent(event)).toBe(event);
  });
});

describe('every invalid example is refused, by name', () => {
  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const problems = runEventProblems(entry.event);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(entry.problem);
    expect(parseRunEvent(entry.event)).toBeNull();
  });

  it('a non-object is refused', () => {
    expect(runEventProblems(null)).toEqual(['run event must be a JSON object']);
    expect(runEventProblems([])).toEqual(['run event must be a JSON object']);
  });
});

describe('run.completed result — exactly the two shapes lanes A1/A2 implement', () => {
  const completed = (result: unknown): unknown => ({
    seq: 9,
    runId: 'r1',
    type: 'run.completed',
    ts: '2026-10-04T10:00:00Z',
    data: { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 }, result },
  });

  it('inline carries kind + value, nothing else', () => {
    expect(runEventProblems(completed({ kind: 'inline', value: 'x' }))).toEqual([]);
    expect(runEventProblems(completed({ kind: 'inline', value: null }))).toEqual([]);
    expect(runEventProblems(completed({ kind: 'inline' })).length).toBeGreaterThan(0);
    expect(runEventProblems(completed({ kind: 'inline', value: 1, sizeBytes: 1 })).length).toBeGreaterThan(0);
  });

  it('ref carries bucket, key, sizeBytes, sha256 — all required', () => {
    const ref = { kind: 'ref', bucket: 'b', key: 'k', sizeBytes: 10, sha256: 'f'.repeat(64) };
    expect(runEventProblems(completed(ref))).toEqual([]);
    for (const key of ['bucket', 'key', 'sizeBytes', 'sha256']) {
      const partial: Record<string, unknown> = { ...ref };
      delete partial[key];
      expect(runEventProblems(completed(partial)).length, key).toBeGreaterThan(0);
    }
    expect(runEventProblems(completed({ ...ref, sha256: 'F'.repeat(64) })).length).toBeGreaterThan(0);
  });
});

describe('SSE framing', () => {
  it.each(fixture.sse.map((entry) => [entry.name, entry] as const))('%s: exact bytes and round trip', (_name, entry) => {
    expect(toSseFrame(entry.event)).toBe(entry.frame);
    expect(parseSseFrame(entry.frame)).toEqual({ kind: 'event', event: entry.event });
  });

  it('serialises the envelope keys in envelope order whatever order they arrive in', () => {
    const event = { data: {}, ts: '2026-10-04T10:00:00Z', type: 'ping', runId: 'r', seq: 3 } as unknown as RunEventV2;
    expect(toSseFrame(event)).toBe('event: ping\nid: 3\ndata: {"seq":3,"runId":"r","type":"ping","ts":"2026-10-04T10:00:00Z","data":{}}\n\n');
  });

  it('refuses to frame an invalid event', () => {
    expect(() =>
      toSseFrame({ seq: 1, runId: 'r', type: 'node.started', ts: '2026-10-04T10:00:00Z', data: { kind: 'core.agent' } } as RunEventV2),
    ).toThrow(/nodeId/);
  });

  it('a comment-only frame is a keep-alive, not an event', () => {
    expect(parseSseFrame(': keep-alive\n\n')).toEqual({ kind: 'comment' });
  });

  it('tolerates CRLF, a missing space after the colon and absent event/id lines', () => {
    const event = fixture.sse[0]!.event;
    const json = JSON.stringify(event);
    expect(parseSseFrame(`event:${event.type}\r\nid:${event.seq}\r\ndata:${json}\r\n\r\n`)).toEqual({ kind: 'event', event });
    expect(parseSseFrame(`data: ${json}\n\n`)).toEqual({ kind: 'event', event });
  });

  it('refuses a frame whose event or id line disagrees with the envelope', () => {
    const event = fixture.sse[0]!.event;
    const json = JSON.stringify(event);
    const wrongType = parseSseFrame(`event: run.started\nid: ${event.seq}\ndata: ${json}\n\n`);
    expect(wrongType.kind).toBe('invalid');
    const wrongId = parseSseFrame(`event: ${event.type}\nid: 999\ndata: ${json}\n\n`);
    expect(wrongId.kind).toBe('invalid');
    expect(parseSseFrame('data: {not json\n\n').kind).toBe('invalid');
  });
});

describe('resume cursor (Last-Event-ID / ?after=)', () => {
  it('reads Last-Event-ID first, then after, else from the beginning', () => {
    expect(parseResumeCursor({ lastEventId: '12', after: '3' })).toEqual({ after: 12 });
    expect(parseResumeCursor({ after: '3' })).toEqual({ after: 3 });
    expect(parseResumeCursor({})).toEqual({ after: 0 });
    expect(parseResumeCursor({ lastEventId: '', after: null })).toEqual({ after: 0 });
  });

  it('refuses a cursor that is not a non-negative decimal integer', () => {
    for (const bad of ['-1', '1.5', 'abc', '0x10', '1e3', ' 7']) {
      expect(parseResumeCursor({ after: bad }), bad).toEqual({ problems: [expect.stringContaining('cursor')] });
    }
  });
});

describe('gap semantics — seq is monotonic but NOT contiguous for a client (F2 fix 1, fix 8)', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEventV2 =>
    ({ seq, runId: 'r', type, ts: '2026-10-04T10:00:00Z', data: {}, ...extra }) as unknown as RunEventV2;
  const delta = (seq: number): RunEventV2 => at(seq, 'output.text.delta', { nodeId: 'n1', data: { field: 'text', text: 'x' } });

  it('a stored event after a jump in seq is delivered and moves the cursor — no loss is inferred', () => {
    // seq 4..6 were admin events filtered off the PUBLIC plane: 3 -> 7 is normal.
    expect(advanceRunCursor(3, delta(7))).toEqual({ cursor: 7, deliver: true, reset: false });
  });

  it('a replayed stored event at or below the cursor is a duplicate and is dropped', () => {
    expect(advanceRunCursor(7, delta(7))).toEqual({ cursor: 7, deliver: false, reset: false });
    expect(advanceRunCursor(7, delta(5))).toEqual({ cursor: 7, deliver: false, reset: false });
  });

  it('ping is never delivered as data and only ever moves the cursor forward', () => {
    expect(advanceRunCursor(3, at(9, 'ping'))).toEqual({ cursor: 9, deliver: false, reset: false });
    expect(advanceRunCursor(9, at(4, 'ping'))).toEqual({ cursor: 9, deliver: false, reset: false });
  });

  it('only the server signals loss: run.resync replaces the client state and sets the cursor to snapshot.lastSeq', () => {
    const resync = at(15, 'run.resync', {
      data: { reason: 'gap', snapshot: { status: 'RUNNING', lastSeq: 15, nodes: {}, outputs: {} } },
    });
    expect(runEventProblems(resync)).toEqual([]);
    expect(advanceRunCursor(12, resync)).toEqual({ cursor: 15, deliver: true, reset: true });
  });

  it('run.resync reasons are the server-side loss signals', () => {
    expect(RUN_RESYNC_REASONS).toEqual(['gap', 'expired', 'cursor_invalid', 'unavailable']);
    const snapshot = { status: 'RUNNING', lastSeq: 2, nodes: {}, outputs: {} };
    for (const reason of RUN_RESYNC_REASONS) {
      expect(runEventProblems(at(2, 'run.resync', { data: { reason, snapshot } })), reason).toEqual([]);
    }
    expect(runEventProblems(at(2, 'run.resync', { data: { reason: 'cursor_expired', snapshot } })).join('\n')).toContain('reason');
  });

  it('the module documentation no longer tells a client that a jump in seq means it missed events', () => {
    const source = readFileSync(join(__dirname, '../run-protocol.ts'), 'utf-8');
    expect(source).not.toMatch(/greater than `last \+ 1` means the client missed/);
    expect(source).toMatch(/NOT contiguous/);
  });
});
