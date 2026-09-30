/**
 * TASK-1023 lane J — the two new lifecycle words (D-C, OD-6) and the cancel
 * bookkeeping they are derived from.
 *
 *   J1  a cancelled download (`cancelledAt` + `finishedAt`, error CANCELLED) → publish
 *       status CANCELLED → lifecycle DOWNLOAD_CANCELLED, placed right after DOWNLOAD_FAILED;
 *   J6  an OPEN unregister older than the download stale window → UNREGISTER_FAILED;
 *       a fresh open one is still UNREGISTERING.
 */
import { describe, expect, it } from 'vitest';
import { AiDeploymentKind, AiModelAvailability } from '@arcaai/domains';
import { deriveModelLifecycle, type LifecycleRow } from '../model-lifecycle.derive';
import {
  DOWNLOAD_CANCELLED_CODE,
  MODEL_PUBLISH_STATUSES,
  derivePublishStatus,
  isUnregisterStale,
  mergeDownloadMeta,
  readDownloadMeta,
  readUnregisterMeta,
} from '../../publish/model-download-meta.util';

const NOW = Date.parse('2026-09-30T10:00:00.000Z');
const OPTS = { now: NOW, staleAfterMs: 300_000 };

function row(over: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: 'm-1',
    slug: 'medical-ner',
    metaData: null,
    availability: AiModelAvailability.MISSING,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    servedBy: 'nlp',
    provider: 'built-in',
    ...over,
  };
}

const cancelled = {
  jobId: 'd-1',
  startedAt: '2026-09-30T09:50:00.000Z',
  finishedAt: '2026-09-30T09:55:00.000Z',
  error: DOWNLOAD_CANCELLED_CODE,
  cancelledAt: '2026-09-30T09:55:00.000Z',
  cancelledBy: 'admin-1',
  bytesDone: 10,
  bytesTotal: 100,
};

function unregister(startedAt: string, over: Record<string, unknown> = {}) {
  return { jobId: 'u-1', startedAt, deleteWeights: true, purge: false, finishedAt: null, error: null, weights: 'deleting', ...over };
}

describe('publish status CANCELLED (J1)', () => {
  it('is a declared publish status', () => {
    expect(MODEL_PUBLISH_STATUSES).toContain('CANCELLED');
  });

  it('a finished run with cancelledAt derives CANCELLED — not DOWNLOAD_FAILED — even with weights present', () => {
    const meta = readDownloadMeta({ download: cancelled });
    expect(derivePublishStatus(meta, 'MISSING', { now: new Date(NOW), staleAfterMs: 300_000 })).toBe('CANCELLED');
    expect(derivePublishStatus(meta, 'AVAILABLE')).toBe('CANCELLED');
  });

  it('a cancel REQUESTED on a running job is still DOWNLOADING until the worker finishes it', () => {
    const meta = readDownloadMeta({
      download: { jobId: 'd-1', startedAt: '2026-09-30T09:59:00Z', finishedAt: null, error: null, heartbeatAt: '2026-09-30T09:59:55Z', cancelRequestedAt: '2026-09-30T09:59:58Z' },
    });
    expect(derivePublishStatus(meta, 'MISSING', { now: new Date(NOW), staleAfterMs: 300_000 })).toBe('DOWNLOADING');
  });

  it('cancel bookkeeping round-trips, and a NEW run (retry) drops it', () => {
    const meta = mergeDownloadMeta({ download: cancelled }, { removeRegistrationOnCancel: true });
    expect(readDownloadMeta(meta)).toMatchObject({ cancelledAt: cancelled.cancelledAt, cancelledBy: 'admin-1', removeRegistrationOnCancel: true });

    const retried = mergeDownloadMeta(meta, { jobId: 'd-2', startedAt: '2026-09-30T10:00:00Z', finishedAt: null, error: null });
    const read = readDownloadMeta(retried)!;
    expect(read.cancelledAt).toBeUndefined();
    expect(read.removeRegistrationOnCancel).toBeUndefined();
    // …so the retried run, once it finishes, is DOWNLOADED — not stuck CANCELLED.
    const done = mergeDownloadMeta(retried, { finishedAt: '2026-09-30T10:05:00Z' });
    expect(derivePublishStatus(readDownloadMeta(done), 'AVAILABLE')).toBe('DOWNLOADED');
  });
});

describe('lifecycle DOWNLOAD_CANCELLED (J1)', () => {
  it('a cancelled download derives DOWNLOAD_CANCELLED and carries the CANCELLED code', () => {
    const lc = deriveModelLifecycle(row({ metaData: { download: cancelled } }), null, OPTS);
    expect(lc.status).toBe('DOWNLOAD_CANCELLED');
    expect(lc.download).toEqual({ bytesDone: 10, bytesTotal: 100, error: 'CANCELLED' });
  });

  it('wins over DOWNLOADED when an earlier download left weights in the bucket', () => {
    const lc = deriveModelLifecycle(row({ availability: AiModelAvailability.AVAILABLE, metaData: { download: cancelled } }), null, OPTS);
    expect(lc.status).toBe('DOWNLOAD_CANCELLED');
  });
});

describe('stale unregister → UNREGISTER_FAILED (J6, OD-6)', () => {
  it('an open unregister inside the stale window is UNREGISTERING', () => {
    const lc = deriveModelLifecycle(row({ metaData: { unregister: unregister('2026-09-30T09:58:00.000Z') } }), null, OPTS);
    expect(lc.status).toBe('UNREGISTERING');
  });

  it('an open unregister older than the stale window is UNREGISTER_FAILED', () => {
    const lc = deriveModelLifecycle(row({ metaData: { unregister: unregister('2026-09-30T09:00:00.000Z') } }), null, OPTS);
    expect(lc.status).toBe('UNREGISTER_FAILED');
    expect(lc.unregister).toEqual({ weights: 'deleting', error: null });
  });

  it('UNREGISTER_FAILED still wins over an in-flight download (documented order)', () => {
    const lc = deriveModelLifecycle(
      row({
        metaData: {
          unregister: unregister('2026-09-30T09:00:00.000Z'),
          download: { jobId: 'd', startedAt: '2026-09-30T09:59:00Z', finishedAt: null, error: null, heartbeatAt: '2026-09-30T09:59:55Z' },
        },
      }),
      null,
      OPTS,
    );
    expect(lc.status).toBe('UNREGISTER_FAILED');
  });

  it('isUnregisterStale needs the caller to resolve the window, and never flags a finished or failed unregister', () => {
    const meta = readUnregisterMeta({ unregister: unregister('2026-09-30T09:00:00.000Z') });
    expect(isUnregisterStale(meta)).toBe(false);
    expect(isUnregisterStale(meta, { now: new Date(NOW), staleAfterMs: 300_000 })).toBe(true);
    expect(isUnregisterStale(readUnregisterMeta({ unregister: unregister('2026-09-30T09:00:00.000Z', { error: 'boom' }) }), { now: new Date(NOW), staleAfterMs: 1 })).toBe(false);
    expect(
      isUnregisterStale(readUnregisterMeta({ unregister: unregister('2026-09-30T09:00:00.000Z', { finishedAt: '2026-09-30T09:01:00Z' }) }), {
        now: new Date(NOW),
        staleAfterMs: 1,
      }),
    ).toBe(false);
  });
});
