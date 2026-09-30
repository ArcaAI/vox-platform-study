/**
 * TASK-1023 J8 — retry after a cancel: `POST :id/download` accepts a CANCELLED
 * row exactly like a failed one, and the new run starts with NO cancel bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiModelDownloadService } from '../ai-model-download.service';
import { readDownloadMeta } from '../model-download-meta.util';

function row(metaData: Record<string, unknown>) {
  return {
    id: 'm-1',
    tenantId: 'sys',
    slug: 'medical-ner',
    version: 4,
    source: 'HUGGINGFACE',
    availability: 'MISSING',
    metaData,
    updatedBy: null as string | null,
  };
}

describe('AiModelDownloadService.triggerDownload — TASK-1023 J8', () => {
  it('re-triggers a CANCELLED row: claims a new run, enqueues it, and the cancel fields are gone', async () => {
    const entity = row({
      download: {
        jobId: 'old',
        startedAt: '2026-09-30T09:00:00Z',
        finishedAt: '2026-09-30T09:05:00Z',
        error: 'CANCELLED',
        cancelledAt: '2026-09-30T09:05:00Z',
        cancelledBy: 'admin-1',
      },
    });
    const repo = { findById: vi.fn().mockResolvedValue(entity), updateWithVersion: vi.fn(async (_id: string, e: unknown) => e) };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : null)) };
    const svc = new AiModelDownloadService(repo as never, queue as never, { emit: vi.fn() } as never, cls as never);

    const out = await svc.triggerDownload('m-1');

    expect(out.status).toBe('DOWNLOADING');
    expect(queue.add).toHaveBeenCalledTimes(1);
    const meta = readDownloadMeta(entity.metaData)!;
    expect(meta.jobId).toBe(out.jobId);
    expect(meta).toMatchObject({ finishedAt: null, error: null });
    expect(meta.cancelledAt).toBeUndefined();
  });
});
