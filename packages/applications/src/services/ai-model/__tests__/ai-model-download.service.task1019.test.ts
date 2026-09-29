/**
 * TASK-1019 — the download PRODUCER (`AiModelDownloadService`).
 *
 *   R3  platform-admin gate on trigger + status (tenant admin 403, super admin with a working tenant 403)
 *   D-4 payload `kind: 'download'`, BullMQ attempts from `modelRegistry.download.maxAttempts`, exponential backoff
 *   D-4 a STALLED download (stale heartbeat) may be re-triggered; a live one is 409
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiModelAvailability, AiModelSource, JobQueue, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';

vi.mock('../publish/model-download-meta.util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../publish/model-download-meta.util')>();
  return { ...actual, derivePublishStatus: vi.fn(actual.derivePublishStatus) };
});

import { derivePublishStatus } from '../publish/model-download-meta.util';
import { AiModelDownloadService } from '../publish/ai-model-download.service';

function cls(opts: { roles?: string[]; tenantId?: string | null } = {}) {
  const roles = opts.roles ?? ['SUPER_ADMIN'];
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'admin-1', roles };
      if (key === 'tenantId') return opts.tenantId ?? null;
      return null;
    }),
  };
}

function entity(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'medical-ner',
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'hf:blaze999/Medical-NER',
    availability: AiModelAvailability.MISSING,
    metaData: null as Record<string, unknown> | null,
    version: 4,
    checksum: null,
    bucketPrefix: null,
    libraryName: 'transformers',
    updatedBy: null,
    ...over,
  };
}

function build(
  opts: { roles?: string[]; tenantId?: string | null; row?: ReturnType<typeof entity> | null; settings?: Record<string, unknown> } = {},
) {
  const row = opts.row === undefined ? entity() : opts.row;
  const repo = {
    findById: vi.fn(async () => {
      if (!row) throw new DataNotFoundException('aiModel', 'm-x');
      return row;
    }),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const events = { emit: vi.fn() };
  const settings = opts.settings
    ? { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in opts.settings! ? opts.settings![key] : fallback)) }
    : undefined;
  const svc = new AiModelDownloadService(repo as never, queue as never, events as never, cls(opts) as never, settings as never);
  return { svc, repo, queue, row };
}

describe('AiModelDownloadService — R3 platform-admin gate', () => {
  it('a tenant admin gets 403 on trigger and on status, before any read', async () => {
    const { svc, repo } = build({ roles: ['TENANT_ADMIN'] });
    await expect(svc.triggerDownload('m-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getDownloadStatus('m-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('a super admin WITH a working tenant gets 403 (the registry is platform-wide)', async () => {
    const { svc, repo } = build({ tenantId: '50000000-0000-0000-0000-000000000000' });
    await expect(svc.triggerDownload('m-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getDownloadStatus('m-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('an unknown id is 404 after the gate', async () => {
    const { svc } = build({ row: null });
    await expect(svc.triggerDownload('m-x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AiModelDownloadService — D-4 job shape and retry policy', () => {
  beforeEach(() => vi.mocked(derivePublishStatus).mockClear());

  it("enqueues kind 'download' with attempts from the descriptor and exponential backoff", async () => {
    const { svc, queue, repo } = build({ settings: { 'modelRegistry.download.maxAttempts': 5 } });
    const out = await svc.triggerDownload('m-1');

    expect(out.status).toBe('DOWNLOADING');
    expect(repo.updateWithVersion).toHaveBeenCalledWith('m-1', expect.anything(), 4, undefined);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, payload, jobOpts] = queue.add.mock.calls[0];
    expect(name).toBe(JobQueue.DownloadAiModel);
    expect(payload).toEqual({ kind: 'download', jobId: out.jobId, aiModelId: 'm-1', tenantId: SYSTEM_TENANT_ID, userId: 'admin-1' });
    expect(jobOpts).toEqual({ jobId: out.jobId, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } });
  });

  it('defaults to 3 attempts with no settings source', async () => {
    const { svc, queue } = build();
    await svc.triggerDownload('m-1');
    expect(queue.add.mock.calls[0][2]).toMatchObject({ attempts: 3 });
  });

  it('starts the heartbeat clock at the claim and resets progress', async () => {
    const { svc, row } = build();
    await svc.triggerDownload('m-1');
    const download = (row!.metaData as Record<string, Record<string, unknown>>).download;
    expect(download.heartbeatAt).toBe(download.startedAt);
    expect(download).toMatchObject({ finishedAt: null, error: null, bytesDone: null, bytesTotal: null });
  });

  it('a live download is 409 and nothing is enqueued', async () => {
    const running = entity({
      metaData: {
        download: { jobId: 'j0', startedAt: new Date().toISOString(), finishedAt: null, error: null, heartbeatAt: new Date().toISOString() },
      },
    });
    const { svc, queue } = build({ row: running });
    await expect(svc.triggerDownload('m-1')).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a STALLED download may be re-triggered — the stale option comes from the descriptor', async () => {
    const stale = entity({
      metaData: { download: { jobId: 'j0', startedAt: '2026-09-29T08:00:00Z', finishedAt: null, error: null, heartbeatAt: '2026-09-29T08:00:10Z' } },
    });
    vi.mocked(derivePublishStatus).mockImplementationOnce(() => 'DOWNLOAD_FAILED');
    const { svc, queue } = build({ row: stale, settings: { 'modelRegistry.download.staleAfterSeconds': 120 } });

    await svc.triggerDownload('m-1');

    expect(derivePublishStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j0' }), AiModelAvailability.MISSING, {
      now: expect.any(Number),
      staleAfterMs: 120_000,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('a model being unregistered is 409', async () => {
    const leaving = entity({
      metaData: { unregister: { jobId: 'u', startedAt: '2026-09-29T09:00:00Z', finishedAt: null, error: null, weights: 'deleting' } },
    });
    const { svc, queue } = build({ row: leaving });
    await expect(svc.triggerDownload('m-1')).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('status of a stalled download reports DOWNLOAD_FAILED with the STALLED code', async () => {
    const stale = entity({ metaData: { download: { jobId: 'j0', startedAt: '2026-09-29T08:00:00Z', finishedAt: null, error: null } } });
    vi.mocked(derivePublishStatus).mockImplementationOnce(() => 'DOWNLOAD_FAILED');
    const { svc } = build({ row: stale });
    const status = await svc.getDownloadStatus('m-1');
    expect(status).toMatchObject({ status: 'DOWNLOAD_FAILED', error: 'STALLED' });
  });
});
