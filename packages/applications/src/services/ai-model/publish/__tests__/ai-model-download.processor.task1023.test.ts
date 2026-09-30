/**
 * TASK-1023 J2 / J4 — the worker half of a cancel (D-C, OD-5, OD-6).
 *
 * A cancelled download: aborts within one heartbeat of the Redis flag (or of the
 * row's `cancelRequestedAt`), aborts in-flight transfers through the job's
 * AbortSignal, wipes its staging dir, deletes the partial objects IT wrote
 * (never a previously AVAILABLE row's weights), records CANCELLED and exits
 * WITHOUT retry. With `removeRegistrationOnCancel` it then unregisters the row
 * (weights deleted) through the existing unregister flow.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { AiModelDownloadProcessor } from '../ai-model-download.processor';
import { readDownloadMeta, readUnregisterMeta } from '../model-download-meta.util';

const INTERVAL = 20;

function entity(over: Record<string, unknown> = {}) {
  return {
    id: 'model-id-1',
    tenantId: 'tenant-1',
    slug: 'gemma',
    version: 7,
    computeType: null,
    format: 'GGUF',
    libraryName: 'llama.cpp',
    source: 'HUGGINGFACE',
    sourceUri: 'org/gemma-gguf',
    sourceRevision: null,
    bucketPrefix: null,
    availability: 'MISSING',
    updatedBy: null as string | null,
    metaData: { download: { jobId: 'job-1', startedAt: new Date().toISOString(), finishedAt: null, error: null } } as Record<string, unknown>,
    markAvailability: vi.fn(),
    ...over,
  };
}

async function stageFile(stagingDir: string, path: string, size: number) {
  const data = Buffer.alloc(size, 7);
  const localPath = join(stagingDir, path);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, data);
  return { path, localPath, size, sha256: createHash('sha256').update(data).digest('hex') };
}

/** Resolves when `signal` aborts, rejecting with its reason — a transfer that only a cancel ends. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('AiModelDownloadProcessor — cancel (TASK-1023)', () => {
  let stagingBaseDir: string;
  let row: ReturnType<typeof entity>;
  let flag: boolean;
  const repo = { findById: vi.fn(), updateWithVersion: vi.fn() };
  const fetcher = { fetch: vi.fn() };
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
  const hf = { getRepoInfo: vi.fn().mockRejectedValue(new Error('offline')) };
  const flags = { isRequested: vi.fn(async () => flag), clear: vi.fn().mockResolvedValue(undefined), request: vi.fn() };
  const unregister = { execute: vi.fn().mockResolvedValue({ weights: 'deleted' }) };
  let store: {
    headObject: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    putSmall: ReturnType<typeof vi.fn>;
    deleteKeys: ReturnType<typeof vi.fn>;
  };

  function processorWith(withFlags = true) {
    return new AiModelDownloadProcessor(
      repo as never,
      fetcher as never,
      cls as never,
      hf as never,
      { create: vi.fn(async () => store) } as never,
      unregister as never,
      { stagingBaseDir, heartbeatIntervalMs: INTERVAL },
      undefined,
      (withFlags ? flags : undefined) as never,
    );
  }

  const job = () =>
    ({
      id: 'job-1',
      data: { kind: 'download', jobId: 'job-1', aiModelId: 'model-id-1', tenantId: 'tenant-1', userId: 'user-1' },
      updateProgress: vi.fn().mockResolvedValue(undefined),
      attemptsMade: 0,
      opts: { attempts: 3 },
    }) as never;

  beforeEach(async () => {
    vi.clearAllMocks();
    flag = false;
    stagingBaseDir = await mkdtemp(join(tmpdir(), 'publisher-cancel-'));
    row = entity();
    repo.findById.mockImplementation(async () => row);
    repo.updateWithVersion.mockImplementation(async (_id: string, e: typeof row) => e);
    store = {
      headObject: vi.fn().mockResolvedValue(null),
      uploadFile: vi.fn().mockResolvedValue(undefined),
      putSmall: vi.fn().mockResolvedValue(undefined),
      deleteKeys: vi.fn(async (keys: string[]) => keys.length),
    };
  });
  afterEach(async () => rm(stagingBaseDir, { recursive: true, force: true }));

  it('J2 — a flag set mid-fetch aborts within one heartbeat: staging wiped, CANCELLED recorded, no retry', async () => {
    fetcher.fetch.mockImplementation(async (_s: string, _u: string, _q: unknown, opts: { stagingDir: string; signal: AbortSignal }) => {
      await stageFile(opts.stagingDir, 'half.gguf', 5);
      return untilAborted(opts.signal);
    });
    const processor = processorWith();

    const running = processor.process(job());
    await new Promise((r) => setTimeout(r, INTERVAL * 2));
    const flaggedAt = Date.now();
    flag = true;
    const error = await running.catch((e: unknown) => e);

    expect(Date.now() - flaggedAt).toBeLessThan(INTERVAL * 5);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain('CANCELLED');
    expect(await readdir(stagingBaseDir)).toEqual([]);
    expect(store.deleteKeys).not.toHaveBeenCalled(); // nothing reached the bucket
    const meta = readDownloadMeta(row.metaData)!;
    expect(meta).toMatchObject({ jobId: 'job-1', error: 'CANCELLED' });
    expect(meta.cancelledAt).toBeTruthy();
    expect(meta.finishedAt).toBeTruthy();
    expect(flags.clear).toHaveBeenCalledWith('job-1');
    expect(unregister.execute).not.toHaveBeenCalled();
  });

  it('J2 — a cancel during the upload aborts it via the signal and deletes the partial objects this job wrote', async () => {
    fetcher.fetch.mockImplementation(async (_s: string, _u: string, _q: unknown, opts: { stagingDir: string }) => [
      await stageFile(opts.stagingDir, 'a.gguf', 4),
      await stageFile(opts.stagingDir, 'b.gguf', 4),
    ]);
    store.uploadFile.mockImplementationOnce(async () => undefined);
    store.uploadFile.mockImplementationOnce(async (_key: string, _path: string, opts: { signal: AbortSignal }) => {
      flag = true;
      return untilAborted(opts.signal);
    });

    const error = await processorWith().process(job()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(store.uploadFile.mock.calls[1][2]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(store.deleteKeys).toHaveBeenCalledTimes(1);
    const deleted = store.deleteKeys.mock.calls[0][0] as string[];
    expect(deleted).toHaveLength(1);
    expect(deleted[0].endsWith('a.gguf')).toBe(true);
    expect(store.putSmall).not.toHaveBeenCalled();
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED' });
    expect(await readdir(stagingBaseDir)).toEqual([]);
  });

  it('OD-6 — a row that was AVAILABLE from an earlier download keeps its weights: nothing is deleted', async () => {
    row = entity({ availability: 'AVAILABLE' });
    fetcher.fetch.mockImplementation(async (_s: string, _u: string, _q: unknown, opts: { stagingDir: string }) => [await stageFile(opts.stagingDir, 'a.gguf', 4)]);
    store.uploadFile.mockImplementationOnce(async () => {
      flag = true;
    });
    const error = await processorWith().process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(store.deleteKeys).not.toHaveBeenCalled();
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED' });
  });

  it("the row's cancelRequestedAt alone (no Redis flag provider) stops the job at the next heartbeat", async () => {
    fetcher.fetch.mockImplementation(async (_s: string, _u: string, _q: unknown, opts: { stagingDir: string; signal: AbortSignal; onBytes: (n: number) => void }) => {
      const ticker = setInterval(() => opts.onBytes(1), INTERVAL / 2);
      setTimeout(() => {
        (row.metaData.download as Record<string, unknown>).cancelRequestedAt = new Date().toISOString();
        (row.metaData.download as Record<string, unknown>).cancelRequestedBy = 'admin-9';
      }, INTERVAL);
      try {
        return await untilAborted(opts.signal);
      } finally {
        clearInterval(ticker);
      }
    });
    const error = await processorWith(false).process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED', cancelledBy: 'admin-9' });
  });

  it('a cancel already requested when the attempt starts ends it before anything is fetched', async () => {
    (row.metaData.download as Record<string, unknown>).cancelRequestedAt = new Date().toISOString();
    const error = await processorWith().process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED' });
  });

  it('J4 — removeRegistrationOnCancel: after cleanup the worker unregisters the row, weights deleted', async () => {
    Object.assign(row.metaData.download as Record<string, unknown>, { cancelRequestedAt: new Date().toISOString(), cancelRequestedBy: 'admin-1', removeRegistrationOnCancel: true });

    const error = await processorWith().process(job()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(unregister.execute).toHaveBeenCalledTimes(1);
    const [payload, opts] = unregister.execute.mock.calls[0];
    expect(payload).toMatchObject({ kind: 'unregister', aiModelId: 'model-id-1', tenantId: 'tenant-1', userId: 'admin-1', deleteWeights: true, purge: false });
    expect(opts).toEqual({ finalAttempt: true });
    const unregisterMeta = readUnregisterMeta(row.metaData)!;
    expect(unregisterMeta).toMatchObject({ jobId: payload.jobId, deleteWeights: true, finishedAt: null, error: null });
    // The cancel was recorded FIRST.
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED' });
  });

  it('J4 — a failing unregister after the cancel does not change the job outcome (still CANCELLED, no retry)', async () => {
    Object.assign(row.metaData.download as Record<string, unknown>, { cancelRequestedAt: new Date().toISOString(), removeRegistrationOnCancel: true });
    unregister.execute.mockRejectedValueOnce(new Error('MODEL_IN_USE'));
    const error = await processorWith().process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(readDownloadMeta(row.metaData)).toMatchObject({ error: 'CANCELLED' });
  });
});
