/**
 * TASK-1038 E2 (fix 14) — the live-transcript mirror never feeds a stale run, and never revives a
 * stream.
 *
 * - A run is mirrored into only while its READ-MODEL row is RUNNING and younger than
 *   `workflowRuns.runStreamMaxOpenHours` — the governed-run marker alone (`governingEngine`) is not
 *   enough: it outlives the run when its terminal update was lost.
 * - Nothing is appended to a run whose `wf:run:<runId>:seq` key is absent: the sequencer would
 *   start a FRESH stream with no TTL (protocol-v2.md §11), i.e. an orphan that never expires.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY } from '@arcaai/applications';
import { SttRunTranscriptMirror } from '../stt-run-transcript-mirror';

const TENANT = '10000000-0000-0000-0000-000000000001';
const SESSION = 'stt-session-1';
const CONSULTATION = 'consultation-1';
const HOURS = 6;

function build(opts: { governedRow?: boolean; lastSeq?: number | null; sandboxRuns?: string[] } = {}) {
  const hub = {
    available: vi.fn(() => true),
    append: vi.fn().mockResolvedValue({ seq: 2, streamId: '2-0', duplicate: false }),
    lastSeq: vi.fn().mockResolvedValue(opts.lastSeq === undefined ? 1 : opts.lastSeq),
  };
  const jobs = { findAll: vi.fn().mockResolvedValue([{ tenantId: TENANT, consultationId: CONSULTATION }]) };
  const consultations = {
    findByIdOrNull: vi.fn().mockResolvedValue({
      id: CONSULTATION,
      tenantId: TENANT,
      metadata: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-g', workflowDefinitionSlug: 'flow' } },
    }),
  };
  const runs = {
    findAll: vi.fn(async (props: { where: Record<string, unknown> }) =>
      props.where.isSandbox === true ? (opts.sandboxRuns ?? []).map((runId) => ({ runId })) : opts.governedRow === false ? [] : [{ runId: 'run-g' }],
    ),
  };
  const settings = { resolvePlatform: vi.fn((key: string) => ({ value: key === WORKFLOW_RUNS_RUN_STREAM_MAX_OPEN_HOURS_KEY ? HOURS : undefined })) };
  const mirror = new SttRunTranscriptMirror(hub as never, jobs as never, consultations as never, runs as never, settings as never);
  return { mirror, hub, runs };
}

const frame = { type: 'transcript', isFinal: true, text: 'chest pain', startTime: 0, endTime: 1 };

beforeEach(() => vi.clearAllMocks());

describe('SttRunTranscriptMirror — staleness', () => {
  it('confirms the governed run on the read model: RUNNING, younger than the ceiling, this tenant', async () => {
    const { mirror, hub, runs } = build();
    const before = Date.now();
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.append).toHaveBeenCalledTimes(1);
    const governedQuery = runs.findAll.mock.calls.map((call) => call[0] as { where: Record<string, unknown> }).find((q) => q.where.runId === 'run-g');
    expect(governedQuery?.where).toMatchObject({ tenantId: TENANT, runId: 'run-g', status: 'RUNNING' });
    const cutoff = (governedQuery?.where.startedAt as { gte: Date }).gte.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - HOURS * 3600_000 - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - HOURS * 3600_000 + 1000);
  });

  it('a governed marker whose run row is not RUNNING (or too old) gets nothing', async () => {
    const { mirror, hub } = build({ governedRow: false });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('the sandbox query is bounded by the same ceiling', async () => {
    const { mirror, runs } = build({ sandboxRuns: ['run-s'] });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    const sandboxQuery = runs.findAll.mock.calls.map((call) => call[0] as { where: Record<string, unknown> }).find((q) => q.where.isSandbox === true);
    expect(sandboxQuery?.where.startedAt).toEqual({ gte: expect.any(Date) });
  });

  it('never appends to a run whose seq key is absent (no stream yet, or expired) — no orphan without a TTL', async () => {
    const { mirror, hub } = build({ lastSeq: null });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.lastSeq).toHaveBeenCalledWith('run-g');
    expect(hub.append).not.toHaveBeenCalled();
  });
});
