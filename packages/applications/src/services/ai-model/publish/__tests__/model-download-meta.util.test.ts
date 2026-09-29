/**
 * `AiModel.metaData` bookkeeping for a download job — `startedAt` /
 * `finishedAt` / `error` have no dedicated columns (the schema comment on
 * `AiModel.downloadStatus` says as much: "manual registry bookkeeping, no
 * write-back automation yet" — packages/database is out of scope for this
 * lane), so they ride in the existing `_metadata` JSONB column under a
 * `download` key, alongside whatever else a row's metaData already holds
 * (the entity doc comment records `TenantTtsConfig`-style extras already use
 * this column the same way).
 */
import { describe, expect, it } from 'vitest';
import { derivePublishStatus, isDownloadStalled, mergeDownloadMeta, mergeUnregisterMeta, readDownloadMeta, readUnregisterMeta } from '../model-download-meta.util';

describe('mergeDownloadMeta', () => {
  it('creates a `download` key on an empty/undefined metaData', () => {
    const result = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: '2026-09-02T00:00:00.000Z' });
    expect(result).toEqual({ download: { jobId: 'job-1', startedAt: '2026-09-02T00:00:00.000Z', finishedAt: null, error: null, sizeMb: null } });
  });

  it('preserves unrelated keys already on metaData', () => {
    const result = mergeDownloadMeta({ voices: ['en-US'] }, { jobId: 'job-1', startedAt: 't0' });
    expect(result.voices).toEqual(['en-US']);
    expect(result.download).toBeDefined();
  });

  it('merges partial updates onto the existing download bookkeeping rather than replacing it', () => {
    const withStart = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    const withFinish = mergeDownloadMeta(withStart, { finishedAt: 't1', error: null, sizeMb: null });
    expect(withFinish.download).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: null, sizeMb: null });
  });

  it('records a failure error without losing startedAt', () => {
    const withStart = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    const withError = mergeDownloadMeta(withStart, { finishedAt: 't1', error: 'HuggingFace 404', sizeMb: null });
    expect(withError.download).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: 'HuggingFace 404', sizeMb: null });
  });
});

describe('readDownloadMeta', () => {
  it('returns null when metaData has no `download` key', () => {
    expect(readDownloadMeta(undefined)).toBeNull();
    expect(readDownloadMeta({ voices: ['en-US'] })).toBeNull();
  });

  it('returns null when `download` is present but malformed', () => {
    expect(readDownloadMeta({ download: 'not-an-object' })).toBeNull();
    expect(readDownloadMeta({ download: null })).toBeNull();
  });

  it('round-trips what mergeDownloadMeta wrote', () => {
    const meta = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    expect(readDownloadMeta(meta)).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: null, error: null, sizeMb: null });
  });
});

// TASK-1019 lane P — progress + liveness (contract `AiModelDownloadProgressMeta`).
describe('progress fields (TASK-1019)', () => {
  it('writes and reads bytesDone / bytesTotal / heartbeatAt / attempt, preserving them across partial merges', () => {
    const started = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0', attempt: 1, bytesTotal: 300, bytesDone: 0 });
    const progressed = mergeDownloadMeta(started, { bytesDone: 120, heartbeatAt: '2026-09-29T10:00:05.000Z' });

    expect(readDownloadMeta(progressed)).toEqual({
      jobId: 'job-1',
      startedAt: 't0',
      finishedAt: null,
      error: null,
      sizeMb: null,
      attempt: 1,
      bytesTotal: 300,
      bytesDone: 120,
      heartbeatAt: '2026-09-29T10:00:05.000Z',
    });
  });

  it('omits progress fields nobody wrote (the pre-TASK-1019 shape is unchanged)', () => {
    const meta = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    expect(Object.keys(meta.download as object).sort()).toEqual(['error', 'finishedAt', 'jobId', 'sizeMb', 'startedAt']);
  });
});

describe('derivePublishStatus — stalled downloads (TASK-1019 D-4)', () => {
  const now = new Date('2026-09-29T10:10:00.000Z');
  const inFlight = (heartbeatAt?: string) => readDownloadMeta(mergeDownloadMeta(undefined, { jobId: 'j', startedAt: '2026-09-29T10:00:00.000Z', ...(heartbeatAt ? { heartbeatAt } : {}) }));

  it('keeps the current behaviour when no staleness options are passed', () => {
    expect(derivePublishStatus(inFlight(), 'UNKNOWN')).toBe('DOWNLOADING');
  });

  it('derives DOWNLOAD_FAILED when the heartbeat is older than staleAfterMs', () => {
    const meta = inFlight('2026-09-29T10:04:00.000Z');
    expect(derivePublishStatus(meta, 'UNKNOWN', { now, staleAfterMs: 300_000 })).toBe('DOWNLOAD_FAILED');
    expect(isDownloadStalled(meta, { now, staleAfterMs: 300_000 })).toBe(true);
  });

  it('stays DOWNLOADING while the heartbeat is fresh', () => {
    const meta = inFlight('2026-09-29T10:08:00.000Z');
    expect(derivePublishStatus(meta, 'UNKNOWN', { now, staleAfterMs: 300_000 })).toBe('DOWNLOADING');
    expect(isDownloadStalled(meta, { now, staleAfterMs: 300_000 })).toBe(false);
  });

  it('falls back to startedAt when no heartbeat was ever written', () => {
    expect(derivePublishStatus(inFlight(), 'UNKNOWN', { now, staleAfterMs: 300_000 })).toBe('DOWNLOAD_FAILED');
    expect(derivePublishStatus(inFlight(), 'UNKNOWN', { now, staleAfterMs: 900_000 })).toBe('DOWNLOADING');
  });

  it('never calls a finished or failed run stalled', () => {
    const done = readDownloadMeta(mergeDownloadMeta(undefined, { jobId: 'j', startedAt: '2026-09-29T09:00:00.000Z', finishedAt: '2026-09-29T09:01:00.000Z' }));
    expect(isDownloadStalled(done, { now, staleAfterMs: 1 })).toBe(false);
    expect(derivePublishStatus(done, 'AVAILABLE', { now, staleAfterMs: 1 })).toBe('DOWNLOADED');
  });
});

describe('unregister bookkeeping (contract `AiModelUnregisterMeta`)', () => {
  it('merges worker fields onto what the gateway wrote and preserves the download key', () => {
    const base = mergeDownloadMeta({ voices: ['x'] }, { jobId: 'dl', startedAt: 't0' });
    const accepted = mergeUnregisterMeta(base, { jobId: 'u1', startedAt: 't1', deleteWeights: true, purge: false, finishedAt: null, error: null, weights: 'deleting' });
    const done = mergeUnregisterMeta(accepted, { finishedAt: 't2', weights: 'deleted', deletedObjects: 3, deletedVersions: 0 });

    expect(done.voices).toEqual(['x']);
    expect(done.download).toBeDefined();
    expect(readUnregisterMeta(done)).toEqual({
      jobId: 'u1',
      startedAt: 't1',
      deleteWeights: true,
      purge: false,
      finishedAt: 't2',
      error: null,
      weights: 'deleted',
      deletedObjects: 3,
      deletedVersions: 0,
    });
  });

  it('reads null when absent or malformed', () => {
    expect(readUnregisterMeta(undefined)).toBeNull();
    expect(readUnregisterMeta({ unregister: 'x' })).toBeNull();
  });
});
