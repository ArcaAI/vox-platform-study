/**
 * TASK-1038 E2 (fix 14) — the backstop for run event streams nothing will ever close.
 *
 * A run stream gets its expiry from its terminal event, or from the §6.1 terminal backstop when a
 * delivery path notices the run ended. A run that died with nobody watching, a stream recreated by
 * a late producer, or a run left RUNNING for good keeps its keys FOREVER (Redis runs without
 * persistence, so it is memory). Every 10 minutes the sweep SCANs `wf:run:*:events`, and for each
 * stream with NO expiry whose run is gone, terminal, or RUNNING past
 * `workflowRuns.runStreamMaxOpenHours`, sets the retention expiry on all three keys (EXPIRE NX —
 * never moving a clock already set). A young RUNNING run is left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY } from '@arcaai/applications';
import { RunEventStreamHub } from '../../workflows/run-event-stream-hub';
import { RunStreamOrphanSweeper } from '../run-stream-orphan-sweeper';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const HOUR = 3_600_000;

type Row = { runId: string; status: string; startedAt: Date };

function build(opts: { keys: string[]; expiring?: string[]; rows: Row[] }) {
  const hub = {
    available: vi.fn(() => true),
    scanRunEventKeys: vi.fn(async (cursor: string) =>
      cursor === '0' ? { cursor: '7', keys: opts.keys.slice(0, 2) } : { cursor: '0', keys: opts.keys.slice(2) },
    ),
    hasExpiry: vi.fn(async (key: string) => (opts.expiring ?? []).includes(key)),
    expireAfterTerminal: vi.fn(async () => undefined),
  };
  const runs = { findAll: vi.fn(async (props: { where: { runId: string } }) => opts.rows.filter((row) => row.runId === props.where.runId)) };
  const settings = { resolvePlatform: vi.fn((key: string) => ({ value: key === WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY ? 24 : undefined })) };
  const sweeper = new RunStreamOrphanSweeper(hub as never, runs as never, settings as never);
  sweeper.now = () => NOW;
  return { sweeper, hub, runs };
}

beforeEach(() => vi.clearAllMocks());

describe('RunStreamOrphanSweeper.sweepOrphans', () => {
  it('closes the streams of gone, terminal and stale-RUNNING runs; leaves young RUNNING and already-expiring ones', async () => {
    const { sweeper, hub } = build({
      keys: ['wf:run:gone:events', 'wf:run:done:events', 'wf:run:stale:events', 'wf:run:young:events', 'wf:run:closing:events'],
      expiring: ['wf:run:closing:events'],
      rows: [
        { runId: 'done', status: 'COMPLETED', startedAt: new Date(NOW.getTime() - 2 * HOUR) },
        { runId: 'stale', status: 'RUNNING', startedAt: new Date(NOW.getTime() - 30 * HOUR) },
        { runId: 'young', status: 'RUNNING', startedAt: new Date(NOW.getTime() - 1 * HOUR) },
        { runId: 'closing', status: 'COMPLETED', startedAt: new Date(NOW.getTime() - 2 * HOUR) },
      ],
    });

    const outcome = await sweeper.sweepOrphans();

    expect(hub.expireAfterTerminal.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual(['done', 'gone', 'stale']);
    expect(outcome).toEqual({ scanned: 5, closed: 3 });
    // The SCAN walked to the end of the keyspace.
    expect(hub.scanRunEventKeys).toHaveBeenCalledTimes(2);
  });

  it('ignores keys that are not a run events key', async () => {
    const { sweeper, hub } = build({ keys: ['wf:run:x:seq', 'wf:run::events'], rows: [] });
    await sweeper.sweepOrphans();
    expect(hub.expireAfterTerminal).not.toHaveBeenCalled();
  });

  it('does nothing without a transport', async () => {
    const { sweeper, hub } = build({ keys: ['wf:run:gone:events'], rows: [] });
    hub.available.mockReturnValue(false);
    expect(await sweeper.sweepOrphans()).toEqual({ scanned: 0, closed: 0 });
    expect(hub.scanRunEventKeys).not.toHaveBeenCalled();
  });

  it('a run lookup failure leaves that stream alone (never closes on a guess)', async () => {
    const { sweeper, hub, runs } = build({ keys: ['wf:run:gone:events'], rows: [] });
    runs.findAll.mockRejectedValue(new Error('db down'));
    await sweeper.sweepOrphans();
    expect(hub.expireAfterTerminal).not.toHaveBeenCalled();
  });
});

describe('RunEventStreamHub — the sweep’s two reads', () => {
  function hubWith(connection: Record<string, unknown>) {
    const hub = new RunEventStreamHub();
    hub.connectionFactory = () => connection as never;
    return hub;
  }

  it('scanRunEventKeys: SCAN <cursor> MATCH wf:run:*:events COUNT <n>', async () => {
    const scan = vi.fn(async () => ['42', ['wf:run:a:events']]);
    const hub = hubWith({ scan });
    expect(await hub.scanRunEventKeys('0', 500)).toEqual({ cursor: '42', keys: ['wf:run:a:events'] });
    expect(scan).toHaveBeenCalledWith('0', 'MATCH', 'wf:run:*:events', 'COUNT', 500);
  });

  it('hasExpiry: PTTL ≥ 0 has one; -1 (none) does not; -2 (gone) counts as expiring (nothing to close)', async () => {
    const pttl = vi.fn(async (key: string) => (key === 'a' ? 1000 : key === 'b' ? -1 : -2));
    const hub = hubWith({ pttl });
    expect(await hub.hasExpiry('a')).toBe(true);
    expect(await hub.hasExpiry('b')).toBe(false);
    expect(await hub.hasExpiry('c')).toBe(true);
  });
});
