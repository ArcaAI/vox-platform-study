/**
 * AiModelDownloadProcessor — the BullMQ worker half of lane L3.
 * Mirrors `IngestKnowledgeDocumentProcessor`/`DirectorySyncProcessor`'s test
 * shape: mocked repository/fetcher/S3/cls boundaries, behavioral entity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiModelDownloadProcessor, HOPE_MODELS_BUCKET } from '../ai-model-download.processor';
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
const mockS3Service = { putFile: vi.fn() };
const mockCls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
const mockHfClient = { getRepoInfo: vi.fn() };

describe('AiModelDownloadProcessor', () => {
  let processor: AiModelDownloadProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCls.run.mockImplementation((fn: () => unknown) => fn());
    mockS3Service.putFile.mockResolvedValue(undefined);
    mockHfClient.getRepoInfo.mockResolvedValue({ sha: 'deadbeefcafe', license: 'apache-2.0', gated: false });
    processor = new AiModelDownloadProcessor(mockRepository as never, mockFetcher as never, mockS3Service as never, mockCls as never, mockHfClient as never);
  });

  function job(data: Record<string, unknown> = {}) {
    return {
      data: { jobId: 'job-1', aiModelId: 'model-id-1', tenantId: 'tenant-1', userId: 'user-1', ...data },
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as never;
  }

  it('throws (fails the job) when tenantId is missing from the payload — fail-closed guard', async () => {
    await expect(processor.process(job({ tenantId: undefined }))).rejects.toThrow();
  });

  it('fetches, publishes every file + SHA256SUMS + manifest.json under <slug>/<version>/, and writes back the row on success', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockResolvedValue([
      { path: 'model-q4_0.gguf', data: Buffer.alloc(1024 * 1024), sha256: 'weights-sha' },
      { path: 'config.json', data: Buffer.alloc(10), sha256: 'config-sha' },
    ]);

    const result = await processor.process(job());

    // Every fetched file uploaded under the derived version prefix, plus SHA256SUMS + manifest.json.
    const uploadedKeys = mockS3Service.putFile.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(mockS3Service.putFile.mock.calls.every((call: unknown[]) => call[0] === HOPE_MODELS_BUCKET)).toBe(true);
    expect(uploadedKeys.filter((k) => k.endsWith('model-q4_0.gguf')).length).toBe(1);
    expect(uploadedKeys.some((k) => k.endsWith('SHA256SUMS'))).toBe(true);
    expect(uploadedKeys.some((k) => k.endsWith('manifest.json'))).toBe(true);
    const versionedPrefix = uploadedKeys[0].slice(0, uploadedKeys[0].indexOf('model-q4_0.gguf'));
    expect(versionedPrefix).toMatch(/^gemma4-e2b-it-qat\/q4-0-[0-9a-f]{12}\/$/);
    expect(uploadedKeys.every((k) => k.startsWith(versionedPrefix))).toBe(true);

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
    expect((model.metaData?.download as Record<string, unknown>).sizeMb).toBe(1);
    const manifestCall = mockS3Service.putFile.mock.calls.find((call: unknown[]) => (call[1] as string).endsWith('manifest.json'));
    const manifestBytes = manifestCall![2] as Buffer;
    expect(model.manifestDigest).toBe(require('node:crypto').createHash('sha256').update(manifestBytes).digest('hex'));
    expect(model.hfRevision).toBe('deadbeefcafe');
    expect(model.checksum).toBeTruthy();
    const download = model.metaData?.download as Record<string, unknown>;
    expect(download.finishedAt).toBeTruthy();
    expect(download.error).toBeNull();
    expect(download.jobId).toBe('job-1');

    expect(result).toMatchObject({ aiModelId: 'model-id-1' });
  });

  it('lays a transformers-family row out as a verbatim HF cache (models--org--repo/snapshots/<sha>/ + refs/main) and derives a DIRECTORY localPath', async () => {
    const model = createBehavioralModelEntity({ slug: 'medical-ner', format: 'SAFETENSOR', libraryName: 'transformers', sourceUri: 'blaze999/Medical-NER' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockResolvedValue([
      { path: 'model.safetensors', data: Buffer.alloc(10), sha256: 'w' },
      { path: 'config.json', data: Buffer.alloc(10), sha256: 'c' },
    ]);

    await processor.process(job());

    const uploadedKeys = mockS3Service.putFile.mock.calls.map((call: unknown[]) => call[1] as string);
    const snapshot = 'hf/hub/models--blaze999--Medical-NER/snapshots/deadbeefcafe/';
    expect(uploadedKeys).toEqual(expect.arrayContaining([`${snapshot}model.safetensors`, `${snapshot}config.json`, `${snapshot}manifest.json`, `${snapshot}SHA256SUMS`, 'hf/hub/models--blaze999--Medical-NER/refs/main']));
    const refsCall = mockS3Service.putFile.mock.calls.find((call: unknown[]) => call[1] === 'hf/hub/models--blaze999--Medical-NER/refs/main');
    expect((refsCall![2] as Buffer).toString('utf8')).toBe('deadbeefcafe');
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
    mockFetcher.fetch.mockResolvedValue([{ path: 'model.safetensors', data: Buffer.alloc(10), sha256: 'w' }]);

    await processor.process(job());

    expect(model.bucketPrefix).toMatch(/^medical-ner\/[0-9a-f]{12}\/$/);
    expect(model.hfRevision).toBeNull();
  });

  it("publishes manifest.json with the row's own `format` — never a hardcoded literal", async () => {
    const model = createBehavioralModelEntity({ format: 'SAFETENSOR', sourceUri: 'org/some-safetensors-repo' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockResolvedValue([{ path: 'model.safetensors', data: Buffer.alloc(10), sha256: 'x' }]);

    await processor.process(job());

    const manifestCall = mockS3Service.putFile.mock.calls.find((call: unknown[]) => (call[1] as string).endsWith('manifest.json'));
    const manifest = JSON.parse((manifestCall![2] as Buffer).toString('utf8'));
    expect(manifest.format).toBe('SAFETENSOR');
  });

  it('uses `computeType` as the quant filter/label when the row has one', async () => {
    const model = createBehavioralModelEntity({ computeType: 'Q4_K_M', sourceUri: 'ibm-granite/granite-guardian-4.1-8b-GGUF' });
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockResolvedValue([{ path: 'granite-Q4_K_M.gguf', data: Buffer.alloc(10), sha256: 'x' }]);

    await processor.process(job());

    expect(mockFetcher.fetch).toHaveBeenCalledWith('HUGGINGFACE', 'ibm-granite/granite-guardian-4.1-8b-GGUF', 'Q4_K_M');
    const uploadedKeys = mockS3Service.putFile.mock.calls.map((call: unknown[]) => call[1] as string);
    // Default slug from the behavioral fixture is 'gemma4-e2b-it-qat'; the quant
    // token is normalized from `computeType` ('Q4_K_M' -> 'q4-k-m').
    expect(uploadedKeys[0]).toMatch(/^gemma4-e2b-it-qat\/q4-k-m-[0-9a-f]{12}\/granite-Q4_K_M\.gguf$/);
  });

  it('marks DOWNLOAD_FAILED and records the error, then rethrows, on a fetch failure', async () => {
    const model = createBehavioralModelEntity();
    mockRepository.findById.mockResolvedValue(model);
    mockRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);
    mockFetcher.fetch.mockRejectedValue(new Error('HuggingFace 404'));

    await expect(processor.process(job())).rejects.toThrow('HuggingFace 404');

    // A FAILED publish records the failure; it does not re-measure the bucket.
    // Claiming MISSING here would erase the weights a previous run staged.
    const download = model.metaData?.download as Record<string, unknown>;
    expect(download.error).toBe('HuggingFace 404');
    expect(model.writes).not.toContain('downloadStatus');
    expect(model.writes).not.toContain('availability');
    expect(download.finishedAt).toBeTruthy();
    expect(mockS3Service.putFile).not.toHaveBeenCalled();
  });

  it('throws (and never writes back) when the model row cannot be found', async () => {
    mockRepository.findById.mockResolvedValue(null);
    await expect(processor.process(job())).rejects.toThrow();
    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});
