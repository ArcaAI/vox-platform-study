/**
 * AiModelDownloadProcessor — the model-publisher worker (TASK-860 lane L3,
 * moved out of hope-api by TASK-1019 lane P).
 * Mirrors `IngestKnowledgeDocumentProcessor`/`DirectorySyncProcessor`'s test
 * shape: mocked repository/fetcher/store/cls boundaries, behavioral entity.
 *
 * Since TASK-1019 every file is STAGED on disk by the fetcher and uploaded
 * through the publisher's own `ModelStore` (never `IS3Service`); the fetcher
 * double below writes real files into the job's staging directory.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { AiModelDownloadProcessor } from '../ai-model-download.processor';
import { MODEL_STORE_CREDENTIAL_MISSING, ModelPublisherError } from '../model-publisher.errors';
import { readDownloadMeta } from '../model-download-meta.util';
import { derivedLocalPath } from '../../constants';

/**
 * A behavioural `AiModelEntity` double that RECORDS every property it is asked
 * to write (`writes`), so the test can assert what the processor does NOT touch
 * as well as what it does — which is the whole point after TASK-890 §3.11
 * removed the four bookkeeping columns.
 */
function createBehavioralModelEntity(overrides: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const state: Record<string, unknown> = {
    id: (overrides.id as string) ?? 'model-id-1',
    tenantId: (overrides.tenantId as string) ?? 'tenant-1',
    slug: (overrides.slug as string) ?? 'gemma4-e2b-it-qat',
    version: (overrides.version as number) ?? 7,
    computeType: (overrides.computeType as string | null) ?? null,
    format: (overrides.format as string) ?? 'GGUF',
    libraryName: (overrides.libraryName as string) ?? 'llama.cpp',
    source: (overrides.source as string) ?? 'HUGGINGFACE',
    sourceUri: (overrides.sourceUri as string) ?? 'google/gemma-4-e2b-it-qat-q4_0-gguf',
    bucketPrefix: null,
    primaryObject: null,
    manifestDigest: null,
    hfRevision: null,
    checksum: null,
    updatedBy: null,
    availability: 'UNKNOWN',
    availabilityCheckedAt: null,
    availabilityDetail: null,
    metaData: (overrides.metaData as Record<string, unknown> | null) ?? { download: { jobId: 'job-1', startedAt: 't0', finishedAt: null, error: null } },
  };

  const entity = new Proxy(
    {
      writes,
      markAvailability(availability: string, detail: unknown = null, checkedAt: Date = new Date()) {
        state.availability = availability;
        state.availabilityDetail = detail;
        state.availabilityCheckedAt = checkedAt;
        writes.push('availability');
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return state[prop];
      },
      set(target, prop: string, value: unknown) {
        if (prop in target) {
          target[prop] = value;
          return true;
        }
        state[prop] = value;
        writes.push(prop);
        return true;
      },
    },
  ) as Record<string, unknown> & { writes: string[]; metaData: Record<string, unknown> | null };

  return entity as never as {
    id: string;
    tenantId: string;
    slug: string;
    version: number;
    sourceUri: string;
    bucketPrefix: string | null;
    primaryObject: string | null;
    manifestDigest: string | null;
    hfRevision: string | null;
    checksum: string | null;
    availability: string;
    metaData: Record<string, unknown> | null;
    writes: string[];
    markAvailability(availability: string, detail?: unknown, checkedAt?: Date): void;
  };
}

const mockRepository = { findById: vi.fn(), updateWithVersion: vi.fn() };
const mockFetcher = { fetch: vi.fn() };
const mockCls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
const mockHfClient = { getRepoInfo: vi.fn() };
const mockStoreFactory = { create: vi.fn() };
const mockUnregister = { execute: vi.fn() };

/** A `ModelStore` double that records puts/uploads by key. */
function createStore() {
  const uploads = new Map<string, Buffer>();
  const store = {
    uploads,
    headObject: vi.fn(async (_key: string): Promise<{ size: number } | null> => null),
    uploadFile: vi.fn(async (key: string, localPath: string) => {
      uploads.set(key, await import('node:fs/promises').then((fs) => fs.readFile(localPath)));
    }),
    putSmall: vi.fn(async (key: string, body: Buffer | string) => {
      uploads.set(key, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    }),
  };
  return store;
}

/** A fetcher double that stages `{ path: size }` into the job's staging dir, as the real one does. */
function stages(files: Record<string, number>) {
  return async (_source: string, _uri: string, _quant: string | null, opts: { stagingDir: string; onPlanned?: (n: number) => void; onBytes?: (n: number) => void }) => {
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    opts.onPlanned?.(total);
    const out = [];
    for (const [path, size] of Object.entries(files)) {
      const data = Buffer.alloc(size, path.length);
      const localPath = join(opts.stagingDir, path);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, data);
      opts.onBytes?.(size);
      out.push({ path, localPath, size, sha256: createHash('sha256').update(data).digest('hex') });
    }
    return out;
  };
}

describe('AiModelDownloadProcessor', () => {
  let processor: AiModelDownloadProcessor;
  let store: ReturnType<typeof createStore>;
  let stagingBaseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCls.run.mockImplementation((fn: () => unknown) => fn());
    mockHfClient.getRepoInfo.mockResolvedValue({ sha: 'deadbeefcafe', license: 'apache-2.0', gated: false });
    store = createStore();
    mockStoreFactory.create.mockResolvedValue(store);
    stagingBaseDir = await mkdtemp(join(tmpdir(), 'publisher-test-'));
    processor = new AiModelDownloadProcessor(
      mockRepository as never,
      mockFetcher as never,
      mockCls as never,
      mockHfClient as never,
      mockStoreFactory as never,
      mockUnregister as never,
      { stagingBaseDir, heartbeatIntervalMs: 5000 },
    );
  });

  afterEach(async () => {
    await rm(stagingBaseDir, { recursive: true, force: true });
  });

  function job(data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return {
      data: { jobId: 'job-1', aiModelId: 'model-id-1', tenantId: 'tenant-1', userId: 'user-1', ...data },
      updateProgress: vi.fn().mockResolvedValue(undefined),
      attemptsMade: 0,
      opts: { attempts: 1 },
      ...extra,
    } as never;
  }

  const uploadedKeys = () => [...store.uploads.keys()];

  it('I8 — sweeps model-publish-* staging dirs a previous container left in the pod, at worker start', async () => {
    const stale = join(stagingBaseDir, 'model-publish-leftover');
    await mkdir(stale);
    await writeFile(join(stale, 'half.gguf'), 'x');
    const past = new Date(Date.now() - 60_000);
    await utimes(stale, past, past);

    await processor.onModuleInit();

    expect(await readdir(stagingBaseDir)).toEqual([]);
  });

  it('throws (fails the job) when tenantId is missing from the payload — fail-closed guard', async () => {
    await expect(processor.process(job({ tenantId: undefined }))).rejects.toThrow();
  });

  it('fetches, publishes every file + SHA256SUMS + manifest.json under <slug>/<version>/, and writes back the row on success (P5 final write)', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model-q4_0.gguf': 1024 * 1024, 'config.json': 10 }));

    const result = await processor.process(job());

    // Every fetched file uploaded under the derived version prefix, plus SHA256SUMS + manifest.json.
    const keys = uploadedKeys();
    expect(keys.filter((k) => k.endsWith('model-q4_0.gguf')).length).toBe(1);
    expect(keys.some((k) => k.endsWith('SHA256SUMS'))).toBe(true);
    expect(keys.some((k) => k.endsWith('manifest.json'))).toBe(true);
    const weightsKey = keys.find((k) => k.endsWith('model-q4_0.gguf'))!;
    const versionedPrefix = weightsKey.slice(0, weightsKey.indexOf('model-q4_0.gguf'));
    expect(versionedPrefix).toMatch(/^gemma4-e2b-it-qat\/q4-0-[0-9a-f]{12}\/$/);
    expect(keys.every((k) => k.startsWith(versionedPrefix))).toBe(true);
    // Weights go through the multipart-capable upload FROM DISK; the two small files through putSmall.
    expect(store.uploadFile).toHaveBeenCalledWith(weightsKey, expect.stringContaining(stagingBaseDir));

    // Row written back: the bucket identity + the MEASURED availability, and
    // `sourceUri` UNCHANGED (the Hub identity stays; the bucket location is
    // `bucketPrefix`). TASK-890 §3.11 — the four bookkeeping columns are NOT
    // written any more; the size rides in the run bookkeeping and the mount path
    // is DERIVED from `bucketPrefix` + `primaryObject` by every reader.
    expect(model.sourceUri).toBe('google/gemma-4-e2b-it-qat-q4_0-gguf');
    expect(model.bucketPrefix).toBe(versionedPrefix);
    expect(model.primaryObject).toBe('model-q4_0.gguf');
    expect(model.availability).toBe('AVAILABLE');
    expect(model.writes).not.toContain('downloadStatus');
    expect(model.writes).not.toContain('localPath');
    expect(model.writes).not.toContain('fileSizeMb');
    expect(model.writes).not.toContain('downloadedAt');
    expect(derivedLocalPath(model)).toBe(`/mnt/models-bucket/${versionedPrefix}model-q4_0.gguf`);
    const manifestBytes = store.uploads.get(`${versionedPrefix}manifest.json`)!;
    expect(model.manifestDigest).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    expect(model.hfRevision).toBe('deadbeefcafe');
    expect(model.checksum).toBeTruthy();
    const download = readDownloadMeta(model.metaData)!;
    expect(download.sizeMb).toBe(1);
    expect(download.finishedAt).toBeTruthy();
    expect(download.error).toBeNull();
    expect(download.jobId).toBe('job-1');
    expect(download.attempt).toBe(1);
    expect(download.bytesTotal).toBe(1024 * 1024 + 10);
    expect(download.bytesDone).toBe(1024 * 1024 + 10);
    expect(download.heartbeatAt).toBeTruthy();

    expect(result).toMatchObject({ aiModelId: 'model-id-1' });
  });

  it('pins the fetch to the resolved Hub commit, so the snapshot name and the bytes agree', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model.gguf': 10 }));

    await processor.process(job());

    expect(mockFetcher.fetch).toHaveBeenCalledWith('HUGGINGFACE', 'google/gemma-4-e2b-it-qat-q4_0-gguf', null, expect.objectContaining({ revision: 'deadbeefcafe' }));
  });

  it('P7 — lays a transformers-family row out as a verbatim HF cache (models--org--repo/snapshots/<sha>/ + refs/main without a trailing newline)', async () => {
    const model = createBehavioralModelEntity({ slug: 'medical-ner', format: 'SAFETENSOR', libraryName: 'transformers', sourceUri: 'blaze999/Medical-NER' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model.safetensors': 10, 'config.json': 10 }));

    await processor.process(job());

    const snapshot = 'hf/hub/models--blaze999--Medical-NER/snapshots/deadbeefcafe/';
    expect(uploadedKeys()).toEqual(
      expect.arrayContaining([`${snapshot}model.safetensors`, `${snapshot}config.json`, `${snapshot}manifest.json`, `${snapshot}SHA256SUMS`, 'hf/hub/models--blaze999--Medical-NER/refs/main']),
    );
    expect(store.uploads.get('hf/hub/models--blaze999--Medical-NER/refs/main')!.toString('utf8')).toBe('deadbeefcafe');
    expect(model.bucketPrefix).toBe(snapshot);
    // The row still NAMES its primary object; a multi-file loader simply does
    // not put it in the derived path — that split is `SINGLE_FILE_LIBRARIES`,
    // which the derivation and this job now share.
    expect(model.primaryObject).toBe('model.safetensors');
    expect(derivedLocalPath(model)).toBe(`/mnt/models-bucket/${snapshot}`);
    expect(model.hfRevision).toBe('deadbeefcafe');
  });

  it('falls back to the flat <slug>/<version>/ layout for a transformers-family row when the Hub sha cannot be resolved', async () => {
    mockHfClient.getRepoInfo.mockRejectedValue(new Error('hub unreachable'));
    const model = createBehavioralModelEntity({ slug: 'medical-ner', format: 'SAFETENSOR', libraryName: 'transformers', sourceUri: 'blaze999/Medical-NER' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model.safetensors': 10 }));

    await processor.process(job());

    expect(model.bucketPrefix).toMatch(/^medical-ner\/[0-9a-f]{12}\/$/);
    expect(model.hfRevision).toBeNull();
  });

  it("publishes manifest.json with the row's own `format` — never a hardcoded literal", async () => {
    const model = createBehavioralModelEntity({ format: 'SAFETENSOR', sourceUri: 'org/some-safetensors-repo' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model.safetensors': 10 }));

    await processor.process(job());

    const manifestKey = uploadedKeys().find((k) => k.endsWith('manifest.json'))!;
    const manifest = JSON.parse(store.uploads.get(manifestKey)!.toString('utf8'));
    expect(manifest.format).toBe('SAFETENSOR');
    expect(manifest.objects[0]).toMatchObject({ path: 'model.safetensors', bytes: 10 });
  });

  it('uses `computeType` as the quant filter/label when the row has one', async () => {
    const model = createBehavioralModelEntity({ computeType: 'Q4_K_M', sourceUri: 'ibm-granite/granite-guardian-4.1-8b-GGUF' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'granite-Q4_K_M.gguf': 10 }));

    await processor.process(job());

    expect(mockFetcher.fetch).toHaveBeenCalledWith('HUGGINGFACE', 'ibm-granite/granite-guardian-4.1-8b-GGUF', 'Q4_K_M', expect.objectContaining({ stagingDir: expect.any(String) }));
    // Default slug from the behavioral fixture is 'gemma4-e2b-it-qat'; the quant
    // token is normalized from `computeType` ('Q4_K_M' -> 'q4-k-m').
    expect(uploadedKeys().find((k) => k.endsWith('.gguf'))).toMatch(/^gemma4-e2b-it-qat\/q4-k-m-[0-9a-f]{12}\/granite-Q4_K_M\.gguf$/);
  });

  it('P6 — a retry skips keys already present with a matching size and re-uploads a size mismatch', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model-q4_0.gguf': 100, 'config.json': 10, 'tokenizer.json': 20 }));
    store.headObject.mockImplementation(async (key: string) => {
      if (key.endsWith('model-q4_0.gguf')) return { size: 100 }; // complete from the failed attempt
      if (key.endsWith('config.json')) return { size: 3 }; // truncated
      return null;
    });

    await processor.process(job({}, { attemptsMade: 1, opts: { attempts: 3 } }));

    const uploadedFiles = store.uploadFile.mock.calls.map((c) => (c[0] as string).split('/').pop());
    expect(uploadedFiles).not.toContain('model-q4_0.gguf');
    expect(uploadedFiles).toEqual(expect.arrayContaining(['config.json', 'tokenizer.json']));
    expect(readDownloadMeta(model.metaData)!.attempt).toBe(2);
    expect(model.availability).toBe('AVAILABLE');
  });

  it('removes the staging directory after success AND after failure', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockImplementation(stages({ 'model.gguf': 10 }));

    await processor.process(job());
    expect(await readdir(stagingBaseDir)).toEqual([]);

    store.uploadFile.mockRejectedValueOnce(new Error('upload broke'));
    await expect(processor.process(job())).rejects.toThrow('upload broke');
    expect(await readdir(stagingBaseDir)).toEqual([]);
  });

  it('marks DOWNLOAD_FAILED and records the error, then rethrows, on a fetch failure (final attempt)', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockRejectedValue(new Error('HuggingFace 404'));

    await expect(processor.process(job())).rejects.toThrow('HuggingFace 404');

    // A FAILED publish records the failure; it does not re-measure the bucket.
    // Claiming MISSING here would erase the weights a previous run staged.
    const download = readDownloadMeta(model.metaData)!;
    expect(download.error).toBe('HuggingFace 404');
    expect(model.writes).not.toContain('downloadStatus');
    expect(model.writes).not.toContain('availability');
    expect(download.finishedAt).toBeTruthy();
    expect(store.uploadFile).not.toHaveBeenCalled();
    expect(store.putSmall).not.toHaveBeenCalled();
  });

  it('with attempts left, a transient failure keeps the row DOWNLOADING for the BullMQ retry (no error recorded)', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockRejectedValue(new Error('ECONNRESET'));

    const failure = await processor.process(job({}, { attemptsMade: 0, opts: { attempts: 3 } })).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
    const download = readDownloadMeta(model.metaData)!;
    expect(download.error).toBeNull();
    expect(download.finishedAt).toBeNull();
    expect(download.heartbeatAt).toBeTruthy();
  });

  it('P8 — publisher credential absent: fails MODEL_STORE_CREDENTIAL_MISSING before fetching, and spends no retries on it', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockStoreFactory.create.mockRejectedValue(new ModelPublisherError(MODEL_STORE_CREDENTIAL_MISSING, 'not set'));

    const failure = await processor.process(job({}, { attemptsMade: 0, opts: { attempts: 3 } })).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toMatch(/^MODEL_STORE_CREDENTIAL_MISSING/);
    expect(mockFetcher.fetch).not.toHaveBeenCalled();
    expect(readDownloadMeta(model.metaData)!.error).toMatch(/^MODEL_STORE_CREDENTIAL_MISSING/);
  });

  it('I10b — a job superseded by a re-trigger (the row names another download jobId) exits without writing anything', async () => {
    const model = createBehavioralModelEntity({ metaData: { download: { jobId: 'job-2', startedAt: 't1', finishedAt: null, error: null } } });
    mockRepository.findById.mockResolvedValue(model);
    mockFetcher.fetch.mockImplementation(stages({ 'model.gguf': 10 }));

    await expect(processor.process(job({ jobId: 'job-1' }))).resolves.toMatchObject({ aiModelId: 'model-id-1', superseded: true });

    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockStoreFactory.create).not.toHaveBeenCalled();
    expect(mockFetcher.fetch).not.toHaveBeenCalled();
    expect(model.writes).toEqual([]);
    expect(readDownloadMeta(model.metaData)!.jobId).toBe('job-2');
  });

  it('throws (and never writes back) when the model row cannot be found', async () => {
    mockRepository.findById.mockResolvedValue(null);
    await expect(processor.process(job())).rejects.toThrow();
    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  describe('job kinds (P10)', () => {
    it("reads a payload with no `kind` (queued before the deploy) as a download", async () => {
      const model = createBehavioralModelEntity();
      mockRepository.findById.mockResolvedValue(model);
      mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
      mockFetcher.fetch.mockImplementation(stages({ 'model.gguf': 10 }));

      await processor.process(job({ kind: undefined }));

      expect(mockFetcher.fetch).toHaveBeenCalledTimes(1);
      expect(mockUnregister.execute).not.toHaveBeenCalled();
      expect(model.availability).toBe('AVAILABLE');
    });

    it("routes `kind: 'unregister'` to the unregister service inside the job's CLS context — no fetch, no upload", async () => {
      mockUnregister.execute.mockResolvedValue({ aiModelId: 'model-id-1', weights: 'deleted', deletedObjects: 2, deletedVersions: 0, bucketPrefix: 'x/y/' });
      const data = { kind: 'unregister', deleteWeights: true, purge: true };

      const result = await processor.process(job(data, { attemptsMade: 2, opts: { attempts: 3 } }));

      expect(mockUnregister.execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unregister', aiModelId: 'model-id-1', purge: true }), { finalAttempt: true });
      expect(mockCls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
      expect(mockFetcher.fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({ weights: 'deleted' });
    });

    it('fails an unregister job closed on a missing tenantId too', async () => {
      await expect(processor.process(job({ kind: 'unregister', tenantId: undefined, deleteWeights: true, purge: false }))).rejects.toThrow();
      expect(mockUnregister.execute).not.toHaveBeenCalled();
    });
  });

  it('never leaves a staging directory behind for a LOCAL row, and never asks the Hub about it', async () => {
    const model = createBehavioralModelEntity({ source: 'LOCAL', sourceUri: 'org/repo' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockRejectedValue(new Error('AiModel source is LOCAL'));

    await expect(processor.process(job())).rejects.toThrow('LOCAL');

    expect(mockHfClient.getRepoInfo).not.toHaveBeenCalled();
    expect(existsSync(stagingBaseDir) ? await readdir(stagingBaseDir) : []).toEqual([]);
  });
});
