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
import { mergeDownloadMeta, readDownloadMeta } from '../model-download-meta.util';

describe('mergeDownloadMeta', () => {
  it('creates a `download` key on an empty/undefined metaData', () => {
    const result = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: '2026-09-02T00:00:00.000Z' });
    expect(result).toEqual({ download: { jobId: 'job-1', startedAt: '2026-09-02T00:00:00.000Z', finishedAt: null, error: null } });
  });

  it('preserves unrelated keys already on metaData', () => {
    const result = mergeDownloadMeta({ voices: ['en-US'] }, { jobId: 'job-1', startedAt: 't0' });
    expect(result.voices).toEqual(['en-US']);
    expect(result.download).toBeDefined();
  });

  it('merges partial updates onto the existing download bookkeeping rather than replacing it', () => {
    const withStart = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    const withFinish = mergeDownloadMeta(withStart, { finishedAt: 't1', error: null });
    expect(withFinish.download).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: null });
  });

  it('records a failure error without losing startedAt', () => {
    const withStart = mergeDownloadMeta(undefined, { jobId: 'job-1', startedAt: 't0' });
    const withError = mergeDownloadMeta(withStart, { finishedAt: 't1', error: 'HuggingFace 404' });
    expect(withError.download).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: 'HuggingFace 404' });
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
    expect(readDownloadMeta(meta)).toEqual({ jobId: 'job-1', startedAt: 't0', finishedAt: null, error: null });
  });
});
