/**
 * TASK-1023 lane J — download-job control on the gateway side (D-C, OD-5, OD-6).
 *
 *   J1  cancel of a QUEUED job → `job.remove()`, bookkeeping CANCELLED now, lifecycle
 *       DOWNLOAD_CANCELLED, outcome `removed` (also when BullMQ already lost the job)
 *   J2  cancel of an ACTIVE job → Redis flag set + cancelRequestedAt/By, outcome `cancelling`
 *   J3  no in-flight download → 409 JOB_NOT_ACTIVE; a second cancel is idempotent;
 *       tenant admin / super admin with a working tenant → 403; unknown id → 404
 *   J4  removeRegistration (queued → unregister enqueued now with deleteWeights; active → intent recorded)
 *   J5  GET jobs merges BullMQ state with row bookkeeping
 *
 * Boundaries mocked: repository, queue (+ jobs), cancel flags, event emitter, CLS.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiDeploymentKind, AiModelAvailability, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ModelPublisherJobsService } from '../model-publisher-jobs.service';
import { readDownloadMeta, readUnregisterMeta } from '../model-download-meta.util';
import { deriveModelLifecycle } from '../../lifecycle/model-lifecycle.derive';

const FRESH = () => new Date(Date.now() - 5_000).toISOString();

function modelRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'medical-ner',
    name: 'Medical NER',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    servedBy: 'nlp',
    provider: 'built-in',
    availability: AiModelAvailability.MISSING,
    bucketPrefix: null as string | null,
    metaData: { download: { jobId: 'job-1', startedAt: FRESH(), finishedAt: null, error: null, heartbeatAt: FRESH() } } as Record<string, unknown> | null,
    version: 5,
    updatedBy: null as string | null,
    ...over,
  };
}

function bullJob(state: string, over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    data: { kind: 'download', jobId: 'job-1', aiModelId: 'm-1', tenantId: SYSTEM_TENANT_ID, userId: 'admin-1' },
    timestamp: Date.parse('2026-09-30T09:00:00Z'),
    finishedOn: undefined as number | undefined,
    failedReason: undefined as string | undefined,
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

interface BuildOpts {
  roles?: string[];
  tenantId?: string | null;
  row?: ReturnType<typeof modelRow> | null;
  rows?: Array<ReturnType<typeof modelRow>>;
  job?: ReturnType<typeof bullJob> | null;
  jobs?: Array<ReturnType<typeof bullJob>>;
}

function build(opts: BuildOpts = {}) {
  const row = opts.row === undefined ? modelRow() : opts.row;
  const repo = {
    findById: vi.fn(async () => {
      if (!row) throw new DataNotFoundException('aiModel', 'x');
      return row;
    }),
    findAll: vi.fn(async () => opts.rows ?? (row ? [row] : [])),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn(async () => (opts.job === undefined ? bullJob('waiting') : opts.job)),
    getJobs: vi.fn(async () => opts.jobs ?? []),
  };
  const flags = { request: vi.fn().mockResolvedValue(undefined), isRequested: vi.fn(), clear: vi.fn() };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'admin-1', roles: opts.roles ?? ['SUPER_ADMIN'] };
      if (key === 'tenantId') return opts.tenantId ?? null;
      return null;
    }),
  };
  const events = { emit: vi.fn() };
  const svc = new ModelPublisherJobsService(repo as never, queue as never, events as never, cls as never, flags as never);
  return { svc, repo, queue, flags, events, row };
}

const OPTS = { now: Date.now(), staleAfterMs: 300_000 };

describe('J1 — cancel a QUEUED download', () => {
  it.each(['waiting', 'delayed', 'prioritized', 'paused'])('%s job → removed, CANCELLED now, DOWNLOAD_CANCELLED', async (state) => {
    const job = bullJob(state);
    const { svc, repo, row, flags } = build({ job });

    const out = await svc.cancelDownload('m-1', {});

    expect(out).toEqual({ jobId: 'job-1', outcome: 'removed', unregisterJobId: null });
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(flags.request).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).toHaveBeenCalledWith('m-1', expect.anything(), 5);
    const meta = readDownloadMeta(row!.metaData)!;
    expect(meta).toMatchObject({ jobId: 'job-1', error: 'CANCELLED', cancelledBy: 'admin-1' });
    expect(meta.finishedAt).toBeTruthy();
    expect(meta.cancelledAt).toBe(meta.finishedAt);
    expect(deriveModelLifecycle(row as never, null, OPTS).status).toBe('DOWNLOAD_CANCELLED');
  });

  it('a job BullMQ no longer holds (lost) is cancelled the same way — outcome removed', async () => {
    const { svc, row } = build({ job: null });
    await expect(svc.cancelDownload('m-1', {})).resolves.toMatchObject({ outcome: 'removed' });
    expect(readDownloadMeta(row!.metaData)?.cancelledAt).toBeTruthy();
  });

  it('a job that turned active between the state read and remove() falls back to the cooperative cancel', async () => {
    const job = bullJob('waiting', { remove: vi.fn().mockRejectedValue(new Error('Job job-1 is locked')) });
    const { svc, flags } = build({ job });
    await expect(svc.cancelDownload('m-1', {})).resolves.toMatchObject({ outcome: 'cancelling' });
    expect(flags.request).toHaveBeenCalledWith('job-1');
  });
});

describe('J2 — cancel an ACTIVE download', () => {
  it('sets the Redis flag and records the request; the row stays in flight for the worker', async () => {
    const job = bullJob('active');
    const { svc, flags, row } = build({ job });

    const out = await svc.cancelDownload('m-1', {});

    expect(out).toEqual({ jobId: 'job-1', outcome: 'cancelling', unregisterJobId: null });
    expect(job.remove).not.toHaveBeenCalled();
    expect(flags.request).toHaveBeenCalledWith('job-1');
    const meta = readDownloadMeta(row!.metaData)!;
    expect(meta).toMatchObject({ cancelRequestedBy: 'admin-1', finishedAt: null, error: null });
    expect(meta.cancelRequestedAt).toBeTruthy();
    expect(meta.cancelledAt).toBeUndefined();
    expect(deriveModelLifecycle(row as never, null, OPTS).status).toBe('DOWNLOADING');
  });
});

describe('J3 — refusals and idempotency', () => {
  it('no in-flight download → 409 JOB_NOT_ACTIVE, nothing touched', async () => {
    const { svc, repo, queue } = build({ row: modelRow({ metaData: { download: { jobId: 'job-1', startedAt: FRESH(), finishedAt: FRESH(), error: null } } }) });
    const error = await svc.cancelDownload('m-1', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'JOB_NOT_ACTIVE' });
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('an already CANCELLED run → 409 JOB_NOT_ACTIVE', async () => {
    const { svc } = build({
      row: modelRow({ metaData: { download: { jobId: 'job-1', startedAt: FRESH(), finishedAt: FRESH(), error: 'CANCELLED', cancelledAt: FRESH() } } }),
    });
    await expect(svc.cancelDownload('m-1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('a second cancel while the worker is stopping the job → 202 cancelling again, nothing re-written', async () => {
    const row = modelRow({
      metaData: { download: { jobId: 'job-1', startedAt: FRESH(), finishedAt: null, error: null, heartbeatAt: FRESH(), cancelRequestedAt: FRESH(), cancelRequestedBy: 'admin-1' } },
    });
    const { svc, repo, flags } = build({ row, job: bullJob('active') });
    await expect(svc.cancelDownload('m-1', {})).resolves.toEqual({ jobId: 'job-1', outcome: 'cancelling', unregisterJobId: null });
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(flags.request).toHaveBeenCalledWith('job-1'); // re-asserting the flag is harmless and heals an expired key
  });

  it('a BullMQ job already completed/failed while the row still reads DOWNLOADING → 409 JOB_NOT_ACTIVE', async () => {
    const { svc } = build({ job: bullJob('completed') });
    await expect(svc.cancelDownload('m-1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('unknown model → 404', async () => {
    const { svc } = build({ row: null });
    await expect(svc.cancelDownload('m-x', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('tenant admin → 403, nothing read', async () => {
    const { svc, repo } = build({ roles: ['TENANT_ADMIN'] });
    await expect(svc.cancelDownload('m-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('super admin with a working tenant → 403', async () => {
    const { svc } = build({ tenantId: '11111111-1111-1111-1111-111111111111' });
    await expect(svc.cancelDownload('m-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('J4 — removeRegistration (OD-5)', () => {
  it('queued: the unregister is accepted and ENQUEUED now, deleteWeights true; its id is returned', async () => {
    const { svc, queue, row } = build({ job: bullJob('waiting') });

    const out = await svc.cancelDownload('m-1', { removeRegistration: true });

    expect(out.outcome).toBe('removed');
    expect(out.unregisterJobId).toEqual(expect.any(String));
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, payload, opts] = queue.add.mock.calls[0];
    expect(payload).toEqual({
      kind: 'unregister',
      jobId: out.unregisterJobId,
      aiModelId: 'm-1',
      tenantId: SYSTEM_TENANT_ID,
      userId: 'admin-1',
      deleteWeights: true,
      purge: false,
    });
    expect(opts).toMatchObject({ jobId: out.unregisterJobId });
    // The row reads CANCELLED for the download and UNREGISTERING for the unregister that follows.
    expect(readDownloadMeta(row!.metaData)).toMatchObject({ error: 'CANCELLED' });
    expect(readUnregisterMeta(row!.metaData)).toMatchObject({ jobId: out.unregisterJobId, deleteWeights: true, finishedAt: null, error: null });
    expect(deriveModelLifecycle(row as never, null, OPTS).status).toBe('UNREGISTERING');
  });

  it('active: the intent is recorded for the worker; nothing enqueued, unregisterJobId null', async () => {
    const { svc, queue, row } = build({ job: bullJob('active') });
    const out = await svc.cancelDownload('m-1', { removeRegistration: true });
    expect(out).toEqual({ jobId: 'job-1', outcome: 'cancelling', unregisterJobId: null });
    expect(queue.add).not.toHaveBeenCalled();
    expect(readDownloadMeta(row!.metaData)).toMatchObject({ removeRegistrationOnCancel: true });
  });

  it('a second cancel that ADDS removeRegistration while cancelling records the intent', async () => {
    const row = modelRow({
      metaData: { download: { jobId: 'job-1', startedAt: FRESH(), finishedAt: null, error: null, heartbeatAt: FRESH(), cancelRequestedAt: FRESH() } },
    });
    const { svc } = build({ row, job: bullJob('active') });
    await svc.cancelDownload('m-1', { removeRegistration: true });
    expect(readDownloadMeta(row.metaData)).toMatchObject({ removeRegistrationOnCancel: true });
  });
});

describe('J5 — GET jobs merges BullMQ with the row bookkeeping', () => {
  function withState(state: string, job: ReturnType<typeof bullJob>) {
    return Object.assign(job, { __state: state });
  }

  function buildList(opts: { jobs: Array<ReturnType<typeof bullJob> & { __state?: string }>; rows: Array<ReturnType<typeof modelRow>>; deleted?: Array<ReturnType<typeof modelRow>> }) {
    const built = build({ rows: opts.rows });
    built.queue.getJobs.mockImplementation(async (types: string[]) => opts.jobs.filter((j) => types.includes(j.__state ?? 'waiting')));
    built.repo.findAll.mockImplementation(async (props: { filters?: Record<string, unknown> }) =>
      props.filters && 'resourceStatus' in props.filters ? (opts.deleted ?? []) : opts.rows,
    );
    return built;
  }

  it('lists download + unregister jobs newest first, with model slug/name, progress, state and starter', async () => {
    const running = modelRow({
      metaData: { download: { jobId: 'job-1', startedAt: '2026-09-30T09:30:00.000Z', finishedAt: null, error: null, bytesDone: 5, bytesTotal: 50, heartbeatAt: FRESH(), attempt: 1 } },
    });
    const other = modelRow({ id: 'm-2', slug: 'whisper', name: 'Whisper', metaData: { unregister: { jobId: 'u-1', startedAt: '2026-09-30T09:40:00.000Z', finishedAt: '2026-09-30T09:41:00.000Z', error: null, weights: 'deleted' } } });
    const { svc } = buildList({
      rows: [running, other],
      jobs: [
        withState('active', bullJob('active')),
        withState('completed', bullJob('completed', { id: 'u-1', data: { kind: 'unregister', jobId: 'u-1', aiModelId: 'm-2', tenantId: SYSTEM_TENANT_ID, userId: 'admin-2', deleteWeights: true, purge: false }, timestamp: Date.parse('2026-09-30T09:40:00Z'), finishedOn: Date.parse('2026-09-30T09:41:00Z') })),
      ],
    });

    const views = await svc.listJobs();

    expect(views.map((v) => v.jobId)).toEqual(['u-1', 'job-1']);
    expect(views[0]).toEqual({
      jobId: 'u-1',
      kind: 'unregister',
      aiModelId: 'm-2',
      modelSlug: 'whisper',
      modelName: 'Whisper',
      state: 'completed',
      bytesDone: null,
      bytesTotal: null,
      startedAt: '2026-09-30T09:40:00.000Z',
      finishedAt: '2026-09-30T09:41:00.000Z',
      startedBy: 'admin-2',
      error: null,
    });
    expect(views[1]).toMatchObject({ jobId: 'job-1', kind: 'download', modelSlug: 'medical-ner', state: 'active', bytesDone: 5, bytesTotal: 50, startedBy: 'admin-1', finishedAt: null, error: null });
  });

  it('a download the worker cancelled (BullMQ failed) reads `cancelled`, not failed', async () => {
    const row = modelRow({ metaData: { download: { jobId: 'job-1', startedAt: '2026-09-30T09:30:00.000Z', finishedAt: '2026-09-30T09:31:00.000Z', error: 'CANCELLED', cancelledAt: '2026-09-30T09:31:00.000Z' } } });
    const { svc } = buildList({ rows: [row], jobs: [withState('failed', bullJob('failed', { failedReason: 'CANCELLED', finishedOn: Date.parse('2026-09-30T09:31:00Z') }))] });
    const [view] = await svc.listJobs();
    expect(view).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' }, finishedAt: '2026-09-30T09:31:00.000Z' });
  });

  it('a genuinely failed job carries its reason', async () => {
    const row = modelRow({ metaData: { download: { jobId: 'job-1', startedAt: '2026-09-30T09:30:00.000Z', finishedAt: '2026-09-30T09:31:00.000Z', error: 'HTTP 404' } } });
    const { svc } = buildList({ rows: [row], jobs: [withState('failed', bullJob('failed', { failedReason: 'HTTP 404' }))] });
    const [view] = await svc.listJobs();
    expect(view).toMatchObject({ state: 'failed', error: { code: 'FAILED', message: 'HTTP 404' } });
  });

  it('a queued cancel (job removed from BullMQ) and a LOST in-flight job are still listed from the row', async () => {
    const cancelled = modelRow({ metaData: { download: { jobId: 'job-c', startedAt: '2026-09-30T09:30:00.000Z', finishedAt: '2026-09-30T09:31:00.000Z', error: 'CANCELLED', cancelledAt: '2026-09-30T09:31:00.000Z' } } });
    const lost = modelRow({ id: 'm-2', slug: 'whisper', name: 'Whisper', metaData: { download: { jobId: 'job-l', startedAt: FRESH(), finishedAt: null, error: null, heartbeatAt: FRESH(), attempt: 1 } } });
    const idle = modelRow({ id: 'm-3', slug: 'idle', metaData: null });
    const { svc } = buildList({ rows: [cancelled, lost, idle], jobs: [] });

    const views = await svc.listJobs();

    expect(views.map((v) => [v.jobId, v.state])).toEqual([
      ['job-l', 'active'],
      ['job-c', 'cancelled'],
    ]);
  });

  it('a superseded download is shown as such (completed, error SUPERSEDED)', async () => {
    const row = modelRow({ metaData: { download: { jobId: 'job-new', startedAt: FRESH(), finishedAt: null, error: null, heartbeatAt: FRESH() } } });
    const old = bullJob('completed', { id: 'job-old', data: { kind: 'download', jobId: 'job-old', aiModelId: 'm-1', tenantId: SYSTEM_TENANT_ID }, returnvalue: { superseded: true } });
    const { svc } = buildList({ rows: [row], jobs: [withState('completed', old)] });
    const views = await svc.listJobs();
    expect(views.find((v) => v.jobId === 'job-old')).toMatchObject({ state: 'completed', error: { code: 'SUPERSEDED' } });
  });

  it('a job whose row is soft-deleted still names the model (deleted rows are read back by id)', async () => {
    const gone = modelRow({ id: 'm-9', slug: 'retired', name: 'Retired' });
    const job = bullJob('completed', { id: 'u-9', data: { kind: 'unregister', jobId: 'u-9', aiModelId: 'm-9', tenantId: SYSTEM_TENANT_ID, deleteWeights: true, purge: false } });
    const { svc } = buildList({ rows: [], deleted: [gone], jobs: [withState('completed', job)] });
    const [view] = await svc.listJobs();
    expect(view).toMatchObject({ modelSlug: 'retired', modelName: 'Retired' });
  });

  it('caps the list at `limit` (default 50, max 200)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      modelRow({ id: `m-${i}`, metaData: { download: { jobId: `j-${i}`, startedAt: new Date(Date.parse('2026-09-30T09:00:00Z') + i * 1000).toISOString(), finishedAt: '2026-09-30T09:30:00Z', error: 'CANCELLED', cancelledAt: '2026-09-30T09:30:00Z' } } }),
    );
    const { svc, queue } = buildList({ rows, jobs: [] });
    expect(await svc.listJobs(2)).toHaveLength(2);
    await svc.listJobs(1000);
    expect(queue.getJobs).toHaveBeenLastCalledWith(expect.any(Array), 0, 199, false);
  });

  it('tenant admin → 403', async () => {
    const { svc } = build({ roles: ['TENANT_ADMIN'] });
    await expect(svc.listJobs()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
