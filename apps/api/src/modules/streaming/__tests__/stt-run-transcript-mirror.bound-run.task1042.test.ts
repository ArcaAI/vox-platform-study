/**
 * TASK-1042 — the live-transcript mirror also follows a session bound to a STANDALONE run
 * (`job.metaData.boundRun.runId`, written at run start). The run is fed under the same rules as a
 * consultation-resolved run: its read-model row is RUNNING and younger than
 * `workflowRuns.runStreamMaxOpenHours`, and its stream already exists. Mirrored events stay
 * admin-audience with no `nodeId` (OD-8) — the event shape is the mirror's own, unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttRunTranscriptMirror } from '../stt-run-transcript-mirror';

const TENANT = '10000000-0000-0000-0000-000000000001';
const SESSION = 'stt-session-1';
const HOURS = 6;

function build(opts: { job?: Record<string, unknown> | null; runRunning?: boolean } = {}) {
  const hub = {
    available: vi.fn(() => true),
    append: vi.fn().mockResolvedValue({ seq: 2, streamId: '2-0', duplicate: false }),
    lastSeq: vi.fn().mockResolvedValue(1),
  };
  const job =
    opts.job === undefined
      ? { tenantId: TENANT, consultationId: null, metaData: { owner: { type: 'apiKey', id: 'k' }, boundRun: { runId: 'run-b' } } }
      : opts.job;
  const jobs = { findAll: vi.fn().mockResolvedValue(job ? [job] : []) };
  const consultations = { findByIdOrNull: vi.fn() };
  const runs = { findAll: vi.fn(async () => (opts.runRunning === false ? [] : [{ runId: 'run-b' }])) };
  const settings = { resolvePlatform: vi.fn(() => ({ value: HOURS })) };
  const mirror = new SttRunTranscriptMirror(hub as never, jobs as never, consultations as never, runs as never, settings as never);
  return { mirror, hub, runs, consultations };
}

const frame = { type: 'transcript', isFinal: true, text: 'chest pain', startTime: 0, endTime: 1 };

beforeEach(() => vi.clearAllMocks());

describe('SttRunTranscriptMirror — a session bound to a standalone run (TASK-1042)', () => {
  it('appends to the bound run while it is RUNNING and within the open-stream ceiling', async () => {
    const { mirror, hub, runs, consultations } = build();
    const before = Date.now();
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.append).toHaveBeenCalledTimes(1);
    expect(hub.append.mock.calls[0][0]).toMatchObject({ runId: 'run-b', type: 'transcript.final', data: { text: 'chest pain' } });
    expect(hub.append.mock.calls[0][0]).not.toHaveProperty('nodeId');
    expect(consultations.findByIdOrNull).not.toHaveBeenCalled();
    const where = (runs.findAll.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ tenantId: TENANT, runId: 'run-b', status: 'RUNNING' });
    expect((where.startedAt as { gte: Date }).gte.getTime()).toBeGreaterThanOrEqual(before - HOURS * 3600_000 - 1000);
  });

  it('a bound run that is no longer RUNNING (or too old) gets nothing', async () => {
    const { mirror, hub } = build({ runRunning: false });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('an unbound session with no consultation is still mirrored nowhere', async () => {
    const { mirror, hub, runs } = build({ job: { tenantId: TENANT, consultationId: null, metaData: { owner: { type: 'apiKey', id: 'k' } } } });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(runs.findAll).not.toHaveBeenCalled();
    expect(hub.append).not.toHaveBeenCalled();
  });

  it('a job row of another tenant is ignored', async () => {
    const { mirror, hub } = build({ job: { tenantId: 'other', consultationId: null, metaData: { boundRun: { runId: 'run-b' } } } });
    mirror.mirror(TENANT, SESSION, frame);
    await mirror.idle(SESSION);
    expect(hub.append).not.toHaveBeenCalled();
  });
});
