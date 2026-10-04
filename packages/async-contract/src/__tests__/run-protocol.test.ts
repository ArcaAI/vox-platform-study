/**
 * TASK-1038 R6 — run protocol v2 (`../run-protocol`), held to the cross-language fixture
 * `tests/contracts/run-protocol.fixture.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_RUN_EVENT_TYPES,
  AGENT_RUN_NODE_ID,
  PUBLIC_RUN_EVENT_TYPES,
  RUN_EVENT_NODE_SCOPE,
  RUN_EVENT_TYPES,
  RUN_EVENT_VISIBILITY,
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_QUERY_PARAM,
  RUN_PROTOCOL_VERSION,
  RUN_RESULT_INLINE_MAX_BYTES,
  RUN_RESYNC_REASONS,
  RUN_APPEND_LUA,
  RUN_DEDUPE_KEY,
  RUN_EVENTS_KEY,
  RUN_SEQ_KEY,
  RUN_STREAM_CLOSED_ERROR,
  RUN_STREAM_FIELDS,
  RUN_STREAM_MAX_LEN,
  TERMINAL_RUN_EVENT_TYPES,
  advanceRunCursor,
  buildRunAppend,
  parseStoredRunEvent,
  planRunResume,
  runEventAudience,
  toPublicRunEvent,
  selectRunProtocol,
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
  query: string;
  inlineResultMaxBytes: number;
  visibility: Record<string, string>;
  nodeScope: Record<string, string>;
  agentRunNodeId: string;
  examples: Array<{ name: string; event: RunEventV2; runKind?: 'agent' | 'workflow' }>;
  invalid: Array<{ name: string; event: unknown; problem: string; runKind?: 'agent' | 'workflow' }>;
  sse: Array<{ name: string; event: RunEventV2; frame: string }>;
  sequencer: {
    keys: { seq: string; events: string; dedupe: string };
    fields: string[];
    maxLen: number;
    closedError: string;
    terminalTypes: string[];
    lua: string;
  };
  stored: Array<{
    name: string;
    append: Parameters<typeof buildRunAppend>[0];
    command: { keys: string[]; args: string[] };
    entry: string[];
    event: RunEventV2;
  }>;
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

  it.each(fixture.examples.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const options = entry.runKind === undefined ? undefined : { runKind: entry.runKind };
    expect(runEventProblems(entry.event, options)).toEqual([]);
    expect(parseRunEvent(entry.event, options)).toBe(entry.event);
  });
});

describe('every invalid example is refused, by name', () => {
  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const options = entry.runKind === undefined ? undefined : { runKind: entry.runKind };
    const problems = runEventProblems(entry.event, options);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(entry.problem);
    expect(parseRunEvent(entry.event, options)).toBeNull();
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

describe('ONE sequencer — the stored shape every producer appends through (F2 fix 2)', () => {
  it('keys, fields, cap, terminal types and the closed error agree with the fixture', () => {
    expect(RUN_SEQ_KEY('r1')).toBe(fixture.sequencer.keys.seq.replace('<runId>', 'r1'));
    expect(RUN_EVENTS_KEY('r1')).toBe(fixture.sequencer.keys.events.replace('<runId>', 'r1'));
    expect(RUN_DEDUPE_KEY('r1')).toBe(fixture.sequencer.keys.dedupe.replace('<runId>', 'r1'));
    // The events key is the literal the gateway (`runEventStreamKey`) and harness (`run_event_stream_key`) already use.
    expect(RUN_EVENTS_KEY('r1')).toBe('wf:run:r1:events');
    expect(RUN_SEQ_KEY('r1')).toBe('wf:run:r1:seq');
    expect([...RUN_STREAM_FIELDS]).toEqual(fixture.sequencer.fields);
    expect(RUN_STREAM_MAX_LEN).toBe(fixture.sequencer.maxLen);
    expect(RUN_STREAM_CLOSED_ERROR).toBe(fixture.sequencer.closedError);
    expect([...TERMINAL_RUN_EVENT_TYPES]).toEqual(fixture.sequencer.terminalTypes);
  });

  it('the Lua script is byte-identical to the fixture (the harness loads the same bytes)', () => {
    expect(RUN_APPEND_LUA).toBe(fixture.sequencer.lua);
  });

  it('the script INCRs the seq key and XADDs the seq as the FIRST field, atomically, trimmed and closable', () => {
    const incr = RUN_APPEND_LUA.indexOf("redis.call('INCR', KEYS[1])");
    const xadd = RUN_APPEND_LUA.indexOf("'XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], '*', 'seq'");
    expect(incr).toBeGreaterThan(-1);
    expect(xadd).toBeGreaterThan(incr);
    expect(RUN_APPEND_LUA).toContain(`redis.error_reply('${RUN_STREAM_CLOSED_ERROR}')`);
    expect(RUN_APPEND_LUA).toContain("redis.call('EXPIRE', KEYS[i], ttl)");
    expect(RUN_APPEND_LUA).toContain("redis.call('HGET', KEYS[3], dedupe)");
  });

  it.each(fixture.stored.map((entry) => [entry.name, entry] as const))('%s: append command and stored entry round trip', (_name, entry) => {
    expect(buildRunAppend(entry.append)).toEqual(entry.command);
    expect(parseStoredRunEvent(entry.append.runId, entry.entry)).toEqual({ kind: 'event', event: entry.event, visibility: entry.entry[entry.entry.indexOf('vis') + 1] });
    expect(runEventProblems(entry.event)).toEqual([]);
  });

  it('refuses to append a synthetic or a non-conforming event', () => {
    const base = { runId: 'r1', ts: '2026-10-04T10:00:00Z' };
    expect(() => buildRunAppend({ ...base, type: 'ping', data: {} })).toThrow(/synthetic/);
    expect(() =>
      buildRunAppend({ ...base, type: 'run.resync', data: { reason: 'gap', snapshot: { status: 'RUNNING', lastSeq: 0, nodes: {}, outputs: {} } } }),
    ).toThrow(/synthetic/);
    expect(() => buildRunAppend({ ...base, type: 'node.started', data: { kind: 'core.agent' } })).toThrow(/nodeId/);
  });

  it('a terminal event closes the stream and must carry the retention; nothing else may', () => {
    const base = { runId: 'r1', ts: '2026-10-04T10:00:00Z' };
    const cancelled = { ...base, type: 'run.cancelled' as const, data: { status: 'CANCELED', durationMs: 1 } };
    expect(() => buildRunAppend(cancelled)).toThrow(/retentionSeconds/);
    expect(buildRunAppend({ ...cancelled, retentionSeconds: 86_400 }).args[1]).toBe('86400');
    expect(() => buildRunAppend({ ...base, type: 'node.started', nodeId: 'n1', data: { kind: 'core.agent' }, retentionSeconds: 60 })).toThrow(
      /retentionSeconds/,
    );
  });

  it('a legacy entry (no seq field) is recognised and skipped; a broken v2 entry is invalid, never guessed', () => {
    expect(parseStoredRunEvent('r1', ['data', '{"schemaVersion":1}'])).toEqual({ kind: 'legacy' });
    expect(parseStoredRunEvent('r1', ['seq', '3', 'type', 'ping', 'ts', '2026-10-04T10:00:00Z', 'vis', 'public', 'body', '{}']).kind).toBe('invalid');
    expect(parseStoredRunEvent('r1', ['seq', '3', 'type', 'run.started', 'ts', '2026-10-04T10:00:00Z', 'vis', 'public', 'body', '{nope']).kind).toBe('invalid');
    expect(parseStoredRunEvent('r1', ['seq', 'x', 'type', 'run.started', 'ts', '2026-10-04T10:00:00Z', 'vis', 'public', 'body', '{}']).kind).toBe('invalid');
  });

  describe('planRunResume — the gateway maps a seq cursor onto the contiguous stored stream', () => {
    it('no stream yet: from the beginning; a cursor into a stream that is gone has expired', () => {
      expect(planRunResume({ after: 0, oldestSeq: null, lastSeq: null })).toEqual({ kind: 'replay', after: 0 });
      expect(planRunResume({ after: 7, oldestSeq: null, lastSeq: null })).toEqual({ kind: 'resync', reason: 'expired' });
    });

    it('a cursor beyond the last stored seq is invalid', () => {
      expect(planRunResume({ after: 20, oldestSeq: 1, lastSeq: 19 })).toEqual({ kind: 'resync', reason: 'cursor_invalid' });
    });

    it('the next seq the cursor needs was trimmed: gap', () => {
      expect(planRunResume({ after: 3, oldestSeq: 5, lastSeq: 19 })).toEqual({ kind: 'resync', reason: 'gap' });
      expect(planRunResume({ after: 4, oldestSeq: 5, lastSeq: 19 })).toEqual({ kind: 'replay', after: 4 });
      expect(planRunResume({ after: 0, oldestSeq: 2, lastSeq: 19 })).toEqual({ kind: 'resync', reason: 'gap' });
    });

    it('everything after the cursor is retained: replay', () => {
      expect(planRunResume({ after: 0, oldestSeq: 1, lastSeq: 19 })).toEqual({ kind: 'replay', after: 0 });
      expect(planRunResume({ after: 19, oldestSeq: 1, lastSeq: 19 })).toEqual({ kind: 'replay', after: 19 });
    });

    it('a counter without retained entries resumes live only from its own tail', () => {
      expect(planRunResume({ after: 19, oldestSeq: null, lastSeq: 19 })).toEqual({ kind: 'replay', after: 19 });
      expect(planRunResume({ after: 12, oldestSeq: null, lastSeq: 19 })).toEqual({ kind: 'resync', reason: 'gap' });
    });
  });
});

describe('protocol selection — header OR query, because EventSource cannot set headers (F2 fix 3)', () => {
  it('the query parameter agrees with the fixture', () => {
    expect(RUN_PROTOCOL_QUERY_PARAM).toBe(fixture.query);
    expect(RUN_PROTOCOL_QUERY_PARAM).toBe('protocol');
  });

  it('`x-hope-run-protocol: 2` or `?protocol=2` selects v2; neither selects the legacy shapes', () => {
    expect(selectRunProtocol({ header: '2' })).toEqual({ version: 2 });
    expect(selectRunProtocol({ query: '2' })).toEqual({ version: 2 });
    expect(selectRunProtocol({})).toEqual({ version: 'legacy' });
    expect(selectRunProtocol({ header: '', query: null })).toEqual({ version: 'legacy' });
  });

  it('the header wins over the query', () => {
    expect(selectRunProtocol({ header: '2', query: '9' })).toEqual({ version: 2 });
  });

  it('an unsupported version is refused, never downgraded', () => {
    for (const bad of ['1', '3', 'v2', ' 2', 'legacy']) {
      expect(selectRunProtocol({ query: bad }), bad).toEqual({ problems: [expect.stringContaining('protocol')] });
    }
  });
});

describe('node scoping — agent runs and session-sourced transcripts (F2 fix 4)', () => {
  const base = { seq: 3, runId: 'r', ts: '2026-10-04T10:00:00Z' };

  it('an agent run has one step, and its nodeId is the convention `agent`', () => {
    expect(AGENT_RUN_NODE_ID).toBe('agent');
    expect(AGENT_RUN_NODE_ID).toBe(fixture.agentRunNodeId);
    const started = { ...base, type: 'node.started', nodeId: 'agent', data: { kind: 'core.agent' } };
    expect(runEventProblems(started, { runKind: 'agent' })).toEqual([]);
    expect(runEventProblems({ ...started, nodeId: 'n_note' }, { runKind: 'agent' }).join('\n')).toContain("nodeId must be 'agent'");
    // A workflow graph names its own node ids — `agent` included — so the rule is agent-runs-only.
    expect(runEventProblems({ ...started, nodeId: 'n_note' }, { runKind: 'workflow' })).toEqual([]);
    expect(runEventProblems({ ...started, nodeId: 'n_note' })).toEqual([]);
  });

  it('nodeId stays required on graph node events, agent run or not', () => {
    const started = { ...base, type: 'node.started', data: { kind: 'core.agent' } };
    expect(runEventProblems(started, { runKind: 'agent' }).join('\n')).toContain('nodeId is required');
  });

  it('transcript.partial|final may omit nodeId (sourced by the consultation session, no ASR node)', () => {
    expect(RUN_EVENT_NODE_SCOPE['transcript.partial']).toBe('optional');
    expect(RUN_EVENT_NODE_SCOPE['transcript.final']).toBe('optional');
    expect(runEventProblems({ ...base, type: 'transcript.final', data: { text: 'Dry cough.' } })).toEqual([]);
    expect(runEventProblems({ ...base, type: 'transcript.partial', nodeId: 'n_asr', data: { text: 'dry' } })).toEqual([]);
  });

  it('every other node-scoped type keeps `required`, and run-level types keep `forbidden`', () => {
    const optional = Object.entries(RUN_EVENT_NODE_SCOPE).filter(([, scope]) => scope === 'optional').map(([type]) => type);
    expect(optional).toEqual(['transcript.partial', 'transcript.final']);
  });
});

describe('per-node outputs on the ADMIN trace (F2 fix 5)', () => {
  const base = { seq: 14, runId: 'r', ts: '2026-10-04T10:00:00Z' };
  const adminOutput = { ...base, type: 'output.data', nodeId: 'n_entities', data: { field: 'entities', value: [], visibility: 'admin' } } as unknown as RunEventV2;
  const publicOutput = { ...base, type: 'output.data', nodeId: 'n_end', data: { field: 'entities', value: [] } } as unknown as RunEventV2;

  it('an admin-trace output.data (visibility: admin) is valid, admin-audience, and never reaches the public plane', () => {
    expect(runEventProblems(adminOutput)).toEqual([]);
    expect(runEventAudience(adminOutput)).toBe('admin');
    expect(toPublicRunEvent(adminOutput)).toBeNull();
  });

  it('an output.data without visibility is the OD-24 public output, unchanged on the public plane', () => {
    expect(runEventAudience(publicOutput)).toBe('public');
    expect(toPublicRunEvent(publicOutput)).toEqual(publicOutput);
  });

  it('`public` is spelled by absence, never explicitly', () => {
    const explicit = { ...publicOutput, data: { field: 'entities', value: [], visibility: 'public' } };
    expect(runEventProblems(explicit).join('\n')).toContain('visibility');
  });

  it('every admin debug type is dropped from the public plane', () => {
    for (const example of fixture.examples) {
      const projected = toPublicRunEvent(example.event);
      if (runEventAudience(example.event) === 'admin') expect(projected, example.name).toBeNull();
      else expect(projected, example.name).not.toBeNull();
    }
  });

  it('the stored entry records the event-level audience in `vis`', () => {
    const command = buildRunAppend({ runId: 'r', type: 'output.data', ts: base.ts, nodeId: 'n_entities', data: { field: 'entities', value: [], visibility: 'admin' } });
    expect(command.args[command.args.indexOf('vis') + 1]).toBe('admin');
  });

  it('run.resync snapshot outputs are keyed by nodeId, then field — two nodes may share a field name', () => {
    const resync = (outputs: unknown): unknown => ({
      seq: 5,
      runId: 'r',
      type: 'run.resync',
      ts: base.ts,
      data: { reason: 'gap', snapshot: { status: 'RUNNING', lastSeq: 5, nodes: {}, outputs } },
    });
    expect(runEventProblems(resync({ n_note: { text: 'Subjective: ' }, n_summary: { text: 'Short.' } }))).toEqual([]);
    expect(runEventProblems(resync({ text: 'Subjective: ' })).join('\n')).toContain('outputs.text');
  });
});

describe('prompt.composed — characters always, tokens only when a tokenizer exists (F2 fix 6)', () => {
  const composed = (data: Record<string, unknown>): unknown => ({
    seq: 7,
    runId: 'r',
    type: 'prompt.composed',
    ts: '2026-10-04T10:00:00Z',
    nodeId: 'n_note',
    data: { selected: [], excluded: [], blocks: [], ...data },
  });

  it('the harness (no tokenizer) sends layer and total characters only', () => {
    expect(runEventProblems(composed({ layers: [{ name: 'instruction', chars: 1200 }], charsTotal: 1200 }))).toEqual([]);
  });

  it('token counts are optional extras, per layer and in total', () => {
    expect(runEventProblems(composed({ layers: [{ name: 'instruction', chars: 1200, tokens: 300 }], charsTotal: 1200, tokensTotal: 300 }))).toEqual([]);
  });

  it('characters stay required — per layer and in total', () => {
    expect(runEventProblems(composed({ layers: [{ name: 'instruction', tokens: 300 }], charsTotal: 0 })).join('\n')).toContain('layers[0].chars is required');
    expect(runEventProblems(composed({ layers: [] })).join('\n')).toContain('charsTotal is required');
  });
});
