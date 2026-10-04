/**
 * TASK-1038 B3a — the gateway side of protocol v2's ONE sequencer (protocol-v2.md §6.1).
 *
 * - every gateway-originated append goes through `RUN_APPEND_LUA` (EVAL on the CONTROL
 *   connection, never the blocking reader), so stored seqs stay contiguous across producers;
 * - a dedupe hit returns the first position; a closed stream refuses the append, and the refusal
 *   is swallowed (best-effort mirror — it never fails a run);
 * - the resume helpers (`lastSeq`, `oldestEntry`, `newestEntry`, `entryIdForSeq`);
 * - deliverable 5: the terminal backstop `EXPIRE … NX` covers ALL THREE keys.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_RUNS_DEFAULTS } from '@arcaai/applications';
import { RUN_DEDUPE_KEY, RUN_EVENTS_KEY, RUN_SEQ_KEY } from '@arcaai/async-contract';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { FakeRedisServer } from './fake-redis-streams';

const CONFIG = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) };
const TS = '2026-10-04T10:00:00.000Z';

function build(server: FakeRedisServer) {
  const hub = new RunEventStreamHub(CONFIG as never, undefined);
  const made: ReturnType<FakeRedisServer['connection']>[] = [];
  hub.connectionFactory = () => {
    const connection = server.connection();
    made.push(connection);
    return connection as never;
  };
  return { hub, made };
}

describe('RunEventStreamHub.append — the sequencer (TASK-1038 B3a deliverable 1)', () => {
  it('appends through RUN_APPEND_LUA: contiguous seqs, the stored v2 entry shape, on the control connection', async () => {
    const server = new FakeRedisServer();
    const { hub, made } = build(server);

    const first = await hub.append({ runId: 'R', type: 'transcript.final', ts: TS, data: { text: 'hello' } });
    const second = await hub.append({ runId: 'R', type: 'node.started', ts: TS, nodeId: 'n_note', data: { kind: 'core.agent' } });

    expect(first).toEqual({ seq: 1, streamId: expect.any(String), duplicate: false });
    expect(second?.seq).toBe(2);
    const stored = server.streams.get(RUN_EVENTS_KEY('R'))!;
    expect(stored[1][1]).toEqual([
      'seq',
      '2',
      'type',
      'node.started',
      'ts',
      TS,
      'nodeId',
      'n_note',
      'vis',
      'public',
      'body',
      JSON.stringify({ kind: 'core.agent' }),
    ]);
    expect(stored[0][1]).toContain('admin'); // transcript.final is admin-audience
    // EVAL went over a non-blocking connection, and no producer XADDed directly.
    const commands = made.flatMap((connection) => connection.commands);
    expect(commands.filter((c) => c === 'eval')).toHaveLength(2);
    expect(commands).not.toContain('xadd');
    await hub.onModuleDestroy();
  });

  it('a dedupe hit returns the first position and writes nothing', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server);
    const input = { runId: 'R', type: 'node.started' as const, ts: TS, nodeId: 'n1', data: { kind: 'core.agent' }, dedupeKey: 'wf:run:R:node:n1:1:started' };

    const a = await hub.append(input);
    const b = await hub.append(input);

    expect(b).toEqual({ seq: a!.seq, streamId: a!.streamId, duplicate: true });
    expect(server.streams.get(RUN_EVENTS_KEY('R'))).toHaveLength(1);
    await hub.onModuleDestroy();
  });

  it('a terminal append starts retention on all three keys; a later append is refused and swallowed (null)', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server);
    await hub.append({ runId: 'R', type: 'node.started', ts: TS, nodeId: 'n1', data: { kind: 'k' }, dedupeKey: 'd1' });
    await hub.append({
      runId: 'R',
      type: 'run.cancelled',
      ts: TS,
      data: { status: 'CANCELED', durationMs: 5 },
      retentionSeconds: 3600,
    });

    expect(server.ttls.get(RUN_SEQ_KEY('R'))).toBe(3600);
    expect(server.ttls.get(RUN_EVENTS_KEY('R'))).toBe(3600);
    expect(server.ttls.get(RUN_DEDUPE_KEY('R'))).toBe(3600);
    await expect(hub.append({ runId: 'R', type: 'transcript.final', ts: TS, data: { text: 'late' } })).resolves.toBeNull();
    expect(server.streams.get(RUN_EVENTS_KEY('R'))).toHaveLength(2);
    await hub.onModuleDestroy();
  });

  it('resolves retentionSeconds for a terminal append from workflowRuns.eventRetentionHours when the caller omits it', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server);
    await hub.append({ runId: 'R', type: 'run.failed', ts: TS, data: { status: 'FAILED', durationMs: 1, error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } } });
    expect(server.ttls.get(RUN_EVENTS_KEY('R'))).toBe(WORKFLOW_RUNS_DEFAULTS.eventRetentionHours * 3600);
    await hub.onModuleDestroy();
  });
});

describe('RunEventStreamHub resume helpers', () => {
  it('lastSeq / oldestEntry / newestEntry / entryIdForSeq read the stored stream', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server);
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) ids.push(server.appendV2({ runId: 'R', type: 'output.text.delta', ts: TS, nodeId: 'n', data: { field: 'text', text: `${i}` } }).id);
    server.trimThrough(RUN_EVENTS_KEY('R'), ids[9]); // seqs 1..10 trimmed

    expect(await hub.lastSeq('R')).toBe(450);
    expect(await hub.lastSeq('absent')).toBeNull();
    expect((await hub.oldestEntry(RUN_EVENTS_KEY('R')))?.id).toBe(ids[10]);
    expect((await hub.newestEntry(RUN_EVENTS_KEY('R')))?.id).toBe(ids[449]);
    expect(await hub.entryIdForSeq(RUN_EVENTS_KEY('R'), 450)).toBe(ids[449]);
    // Several XREVRANGE pages back from the tail.
    expect(await hub.entryIdForSeq(RUN_EVENTS_KEY('R'), 11)).toBe(ids[10]);
    expect(await hub.entryIdForSeq(RUN_EVENTS_KEY('R'), 5)).toBeNull();
    await hub.onModuleDestroy();
  });
});

describe('RunEventStreamHub.expireAfterTerminal — deliverable 5', () => {
  it('sets EXPIRE … NX on the seq, events AND dedupe keys', async () => {
    const server = new FakeRedisServer();
    const { hub } = build(server);
    server.appendV2({ runId: 'R', type: 'node.started', ts: TS, nodeId: 'n', data: { kind: 'k' }, dedupeKey: 'x' });

    await hub.expireAfterTerminal('R');

    const ttl = WORKFLOW_RUNS_DEFAULTS.eventRetentionHours * 3600;
    expect(server.ttls.get(RUN_SEQ_KEY('R'))).toBe(ttl);
    expect(server.ttls.get(RUN_EVENTS_KEY('R'))).toBe(ttl);
    expect(server.ttls.get(RUN_DEDUPE_KEY('R'))).toBe(ttl);
    // NX — a second observer never extends the clock.
    server.ttls.set(RUN_EVENTS_KEY('R'), 10);
    await hub.expireAfterTerminal('R');
    expect(server.ttls.get(RUN_EVENTS_KEY('R'))).toBe(10);
    await hub.onModuleDestroy();
  });
});
