/**
 * TASK-1039 — the run follow engine behind `useRun`: reconnect, resume by `seq`, `run.resync`,
 * and the rule that a jump in `seq` is never read as loss.
 *
 * The connector is faked: each call is one connection. It pushes frames through `onFrame` and
 * resolves when the "connection" ends (a drop is just a connector that resolves before a terminal
 * event). That is the same contract the EventSource and fetch connectors keep.
 */

import { describe, expect, it, vi } from 'vitest';
import { followRun, RunStreamHttpError, RunStreamInterruptedError, type RawRunFrame, type RunConnector } from '../RunStreamClient';
import type { RunEventV2 } from '../run-protocol';

const TS = '2026-10-04T10:00:00.000Z';

function v2(type: string, seq: number, data: Record<string, unknown>, nodeId?: string): RawRunFrame {
  return { event: type, id: String(seq), data: JSON.stringify({ seq, runId: 'run-1', type, ts: TS, ...(nodeId ? { nodeId } : {}), data }) };
}

const completed = (seq: number) => v2('run.completed', seq, { status: 'COMPLETED', durationMs: 5, tokens: { in: 1, out: 2 } });
const delta = (seq: number, text: string) => v2('output.text.delta', seq, { field: 'text', text }, 'n1');

/** A scripted connector: connection N plays script[N], then ends (or throws when the entry is an Error). */
function scripted(script: Array<RawRunFrame[] | Error>) {
  const calls: Array<{ after: number | undefined; legacyId: string | undefined }> = [];
  const connector: RunConnector = async ({ after, legacyId, onFrame }) => {
    calls.push({ after, legacyId });
    const step = script[calls.length - 1] ?? [];
    if (step instanceof Error) throw step;
    for (const frame of step) onFrame(frame);
  };
  return { connector, calls };
}

function collect() {
  const seen: Array<{ event: RunEventV2; reset: boolean }> = [];
  return { seen, onEvent: (event: RunEventV2, info: { reset: boolean }) => seen.push({ event, reset: info.reset }) };
}

const fast = { reconnectDelayMs: 0 };

describe('followRun', () => {
  it('delivers events in order and ends after the terminal one', async () => {
    const { connector, calls } = scripted([[v2('run.started', 1, { kind: 'workflow', slug: 's', versionNumber: 1 }), delta(2, 'Hel'), delta(3, 'lo'), completed(4)]]);
    const { seen, onEvent } = collect();

    const outcome = await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    expect(outcome).toBe('terminal');
    expect(seen.map((s) => s.event.type)).toEqual(['run.started', 'output.text.delta', 'output.text.delta', 'run.completed']);
    expect(calls).toHaveLength(1);
  });

  it('resumes by seq after a drop and drops the replayed duplicates', async () => {
    const { connector, calls } = scripted([
      [delta(1, 'a'), delta(2, 'b')], // the connection ends here: a drop, no terminal event
      [delta(2, 'b'), delta(3, 'c'), completed(4)], // the server replays seq 2 again
    ]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    expect(calls.map((c) => c.after)).toEqual([undefined, 2]);
    expect(seen.map((s) => s.event.seq)).toEqual([1, 2, 3, 4]);
  });

  it('starts from a cursor the caller persisted ("resume on mount")', async () => {
    const { connector, calls } = scripted([[delta(8, 'x'), completed(9)]]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, after: 7, ...fast });

    expect(calls[0]!.after).toBe(7);
    expect(seen.map((s) => s.event.seq)).toEqual([8, 9]);
  });

  it('never reads a jump in seq as loss: no reconnect, no resync, the event is delivered', async () => {
    const { connector, calls } = scripted([[delta(3, 'a'), delta(7, 'b'), completed(12)]]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    expect(calls).toHaveLength(1);
    expect(seen.map((s) => s.event.seq)).toEqual([3, 7, 12]);
    expect(seen.some((s) => s.reset)).toBe(false);
  });

  it('moves the cursor on a ping without delivering it', async () => {
    const { connector, calls } = scripted([[delta(1, 'a'), v2('ping', 9, {})], [completed(10)]]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    expect(calls.map((c) => c.after)).toEqual([undefined, 9]);
    expect(seen.map((s) => s.event.type)).toEqual(['output.text.delta', 'run.completed']);
  });

  it('delivers run.resync with reset and continues from the server cursor', async () => {
    const resync = v2('run.resync', 12, {
      reason: 'gap',
      snapshot: { status: 'RUNNING', lastSeq: 12, nodes: {}, outputs: { n1: { text: 'Hello wor' } } },
    });
    const { connector } = scripted([[delta(1, 'Hel'), resync, delta(13, 'ld'), completed(14)]]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    const resynced = seen.find((s) => s.event.type === 'run.resync');
    expect(resynced?.reset).toBe(true);
    expect(seen.map((s) => s.event.seq)).toEqual([1, 12, 13, 14]);
  });

  it('ends on a resync whose snapshot is already terminal', async () => {
    const resync = v2('run.resync', 20, { reason: 'expired', snapshot: { status: 'COMPLETED', lastSeq: 20, nodes: {}, outputs: {} } });
    const { connector, calls } = scripted([[resync]]);
    const { onEvent } = collect();

    expect(await followRun({ runId: 'run-1', connector, onEvent, after: 5, ...fast })).toBe('terminal');
    expect(calls).toHaveLength(1);
  });

  it('gives up with RunStreamInterruptedError after the reconnect budget is spent without a single frame', async () => {
    const { connector, calls } = scripted([[delta(1, 'a')], [], [], []]);
    const { onEvent } = collect();

    const failure = followRun({ runId: 'run-1', connector, onEvent, maxReconnects: 2, ...fast });

    await expect(failure).rejects.toBeInstanceOf(RunStreamInterruptedError);
    await expect(failure).rejects.toMatchObject({ runId: 'run-1', lastSeq: 1 });
    expect(calls).toHaveLength(4); // one productive connection, then 3 empty ones (budget 2 => the 3rd empty one is fatal)
  });

  it('a connection that delivers anything resets the budget', async () => {
    const { connector } = scripted([[delta(1, 'a')], [], [delta(2, 'b')], [], [completed(3)]]);
    const { onEvent } = collect();

    expect(await followRun({ runId: 'run-1', connector, onEvent, maxReconnects: 1, ...fast })).toBe('terminal');
  });

  it('retries a transient connect error and throws a client error at once', async () => {
    const transient = scripted([new RunStreamHttpError(503), [completed(1)]]);
    const { onEvent } = collect();
    expect(await followRun({ runId: 'run-1', connector: transient.connector, onEvent, ...fast })).toBe('terminal');

    const fatal = scripted([new RunStreamHttpError(404)]);
    await expect(followRun({ runId: 'run-1', connector: fatal.connector, onEvent, ...fast })).rejects.toMatchObject({ status: 404 });
    expect(fatal.calls).toHaveLength(1);
  });

  it('stops quietly when the signal aborts, and stays on the run (there is nothing here that could cancel it)', async () => {
    const controller = new AbortController();
    const connector: RunConnector = vi.fn(async ({ onFrame, signal }) => {
      onFrame(delta(1, 'a'));
      controller.abort();
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const { seen, onEvent } = collect();

    const outcome = await followRun({ runId: 'run-1', connector, onEvent, signal: controller.signal, ...fast });

    expect(outcome).toBe('aborted');
    expect(seen).toHaveLength(1);
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it('resumes a legacy stream with the frame id it saw, not a seq', async () => {
    const legacy = (type: string, payload: Record<string, unknown>, id?: string): RawRunFrame => ({
      event: type,
      id,
      data: JSON.stringify({ schemaVersion: 1, id: 'e', tenantId: 't', type, occurredAt: TS, correlationId: 'run-1', causationId: null, idempotencyKey: 'k', payload }),
    });
    const { connector, calls } = scripted([
      [legacy('workflow.token.delta', { nodeId: 'n1', text: 'Hi' }, '5-0')],
      [legacy('workflow.run.completed', { status: 'SUCCEEDED' }, '6-0')],
    ]);
    const { seen, onEvent } = collect();

    await followRun({ runId: 'run-1', connector, onEvent, ...fast });

    expect(calls[1]).toEqual({ after: undefined, legacyId: '5-0' });
    expect(seen.map((s) => s.event.type)).toEqual(['output.text.delta', 'run.completed']);
  });
});
