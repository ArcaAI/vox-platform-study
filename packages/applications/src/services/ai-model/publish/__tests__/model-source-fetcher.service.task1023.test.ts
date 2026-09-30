/**
 * TASK-1023 — the fetcher threads the JOB's tenant (OD-3) and the cancel signal
 * (D-C) into every Hub call, and stops between files once cancelled.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiModelSource } from '@arcaai/domains';
import { ModelSourceFetcherService } from '../model-source-fetcher.service';

describe('ModelSourceFetcherService — tenant + cancel signal (TASK-1023)', () => {
  const hf = { listRepoFiles: vi.fn(), downloadFileTo: vi.fn() };
  let dir: string;
  let service: ModelSourceFetcherService;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'fetch-1023-'));
    hf.listRepoFiles.mockResolvedValue([
      { path: 'a.safetensors', size: 10 },
      { path: 'config.json', size: 2 },
    ]);
    service = new ModelSourceFetcherService(hf as never, {} as never, vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('passes tenantId to the listing and tenantId + signal to every download', async () => {
    hf.downloadFileTo.mockResolvedValue({ size: 1, sha256: 'x' });
    const signal = new AbortController().signal;
    await service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, { stagingDir: dir, tenantId: 't-1', signal });
    expect(hf.listRepoFiles).toHaveBeenCalledWith('org/repo', 'main', { tenantId: 't-1' });
    expect(hf.downloadFileTo).toHaveBeenCalledWith(
      'org/repo',
      'a.safetensors',
      'main',
      expect.any(String),
      undefined,
      expect.objectContaining({ tenantId: 't-1', signal }),
    );
  });

  it('a cancel during the first file stops before the next one starts, rejecting with the cancel reason', async () => {
    const controller = new AbortController();
    const reason = new Error('CANCELLED');
    hf.downloadFileTo.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { size: 10, sha256: 'x' };
    });
    await expect(service.fetch(AiModelSource.HUGGINGFACE, 'org/repo', null, { stagingDir: dir, signal: controller.signal })).rejects.toBe(reason);
    expect(hf.downloadFileTo).toHaveBeenCalledTimes(1);
  });
});
