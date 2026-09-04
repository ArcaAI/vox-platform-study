/**
 * ModelInventoryService — measures whether each registry row's weights are in
 * the `hope-models` bucket (TASK-860 R-2 / README §3.4).
 *
 * Boundaries mocked: the bucket (`IS3Service.listFiles` / `getFile`), the
 * repository, the base client. Availability is a FACT about the bucket, so
 * every verdict below is derived from the listing + the manifest bytes alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { AiDeploymentKind, AiModelAvailability, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelInventoryService } from '../model-inventory.service';
import { HOPE_MODELS_BUCKET } from '../../constants';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function manifest(objects: string[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    slug: 'x',
    version: 'v',
    objects: objects.map((path) => ({ path, role: 'weights', bytes: 1, sha256: 'h' })),
    ...extra,
  });
}

function row(over: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    id: 'row-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'medical-ner',
    libraryName: 'transformers',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    bucketPrefix: null,
    manifestDigest: null,
    availability: AiModelAvailability.UNKNOWN,
    availabilityCheckedAt: null,
    availabilityDetail: null,
    version: 1,
    ...over,
  };
  return {
    ...state,
    get isCloud() {
      return state.deploymentKind === AiDeploymentKind.CLOUD;
    },
    markAvailability: vi.fn((availability: string, detail: unknown, checkedAt: Date) => {
      state.availability = availability;
      state.availabilityDetail = detail;
      state.availabilityCheckedAt = checkedAt;
    }),
    manifestDigest: state.manifestDigest,
    get state() {
      return state;
    },
  } as never as Record<string, unknown> & { markAvailability: ReturnType<typeof vi.fn>; state: Record<string, unknown> };
}

const BASE_CLIENT = { __lane: 'base' };

describe('ModelInventoryService.runInventory', () => {
  const s3 = { listFiles: vi.fn(), getFile: vi.fn() };
  const repo = { findAll: vi.fn(), update: vi.fn(async (_id: string, e: unknown) => e) };
  const db = { baseClient: BASE_CLIENT };
  let service: ModelInventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ModelInventoryService(repo as never, s3 as never, db as never);
  });

  it('lists the whole bucket once, reads only the SYSTEM catalogue, and writes every verdict through the base-client lane', async () => {
    const m = manifest(['model.safetensors']);
    s3.listFiles.mockResolvedValue([{ key: 'medical-ner/abc/manifest.json' }, { key: 'medical-ner/abc/model.safetensors' }, { key: 'medical-ner/abc/SHA256SUMS' }]);
    s3.getFile.mockResolvedValue(Buffer.from(m));
    const r = row({ bucketPrefix: 'medical-ner/abc/', manifestDigest: sha256(m) });
    repo.findAll.mockResolvedValue([r]);

    const report = await service.runInventory();

    expect(s3.listFiles).toHaveBeenCalledTimes(1);
    expect(s3.listFiles).toHaveBeenCalledWith(HOPE_MODELS_BUCKET, '');
    expect(repo.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }) }));
    expect(r.markAvailability).toHaveBeenCalledWith(AiModelAvailability.AVAILABLE, expect.anything(), expect.any(Date));
    expect(repo.update).toHaveBeenCalledWith('row-1', r, BASE_CLIENT);
    expect(report.rows).toEqual([expect.objectContaining({ id: 'row-1', slug: 'medical-ner', availability: AiModelAvailability.AVAILABLE })]);
    expect(report.counts.available).toBe(1);
  });

  it('a CLOUD row and a weight-less library are NOT_APPLICABLE and never hit the bucket', async () => {
    s3.listFiles.mockResolvedValue([]);
    const cloud = row({ id: 'c', slug: 'azure-speech-stt', deploymentKind: AiDeploymentKind.CLOUD, libraryName: 'azure-speech' });
    const rnnoise = row({ id: 'r', slug: 'rnnoise', libraryName: 'pyrnnoise' });
    repo.findAll.mockResolvedValue([cloud, rnnoise]);

    const report = await service.runInventory();

    expect(cloud.markAvailability).toHaveBeenCalledWith(AiModelAvailability.NOT_APPLICABLE, expect.anything(), expect.any(Date));
    expect(rnnoise.markAvailability).toHaveBeenCalledWith(AiModelAvailability.NOT_APPLICABLE, expect.anything(), expect.any(Date));
    expect(s3.getFile).not.toHaveBeenCalled();
    expect(report.counts.notApplicable).toBe(2);
  });

  it('a self-hosted row with no bucketPrefix, or whose manifest is not in the bucket, is MISSING', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'other/abc/manifest.json' }]);
    const unpublished = row({ id: 'u', slug: 'nemotron' });
    const gone = row({ id: 'g', slug: 'kokoro', bucketPrefix: 'kokoro/def/', manifestDigest: 'x' });
    repo.findAll.mockResolvedValue([unpublished, gone]);

    const report = await service.runInventory();

    expect(unpublished.markAvailability).toHaveBeenCalledWith(AiModelAvailability.MISSING, expect.objectContaining({ reason: expect.stringMatching(/bucketPrefix/) }), expect.any(Date));
    expect(gone.markAvailability).toHaveBeenCalledWith(AiModelAvailability.MISSING, expect.objectContaining({ reason: expect.stringMatching(/manifest/) }), expect.any(Date));
    expect(report.counts.missing).toBe(2);
  });

  it('a manifest whose objects are partly absent, or whose digest drifted, is PARTIAL with the detail naming why', async () => {
    const m = manifest(['a.gguf', 'b.gguf']);
    s3.listFiles.mockResolvedValue([{ key: 'p/v/manifest.json' }, { key: 'p/v/a.gguf' }, { key: 'q/v/manifest.json' }, { key: 'q/v/w.bin' }]);
    s3.getFile.mockImplementation(async (_b: string, key: string) => Buffer.from(key.startsWith('p/') ? m : manifest(['w.bin'])));
    const partial = row({ id: 'p', slug: 'p', bucketPrefix: 'p/v/', manifestDigest: sha256(m) });
    const drifted = row({ id: 'q', slug: 'q', bucketPrefix: 'q/v/', manifestDigest: 'stale-digest' });
    repo.findAll.mockResolvedValue([partial, drifted]);

    const report = await service.runInventory();

    expect(partial.markAvailability).toHaveBeenCalledWith(AiModelAvailability.PARTIAL, expect.objectContaining({ missingObjects: ['b.gguf'] }), expect.any(Date));
    expect(drifted.markAvailability).toHaveBeenCalledWith(AiModelAvailability.PARTIAL, expect.objectContaining({ manifestDigestMismatch: true }), expect.any(Date));
    expect(report.counts.partial).toBe(2);
  });

  it('adopts the manifest digest for a row that has none (registered from the bucket) when every object is present', async () => {
    const m = manifest(['model.gguf']);
    s3.listFiles.mockResolvedValue([{ key: 'r/v/manifest.json' }, { key: 'r/v/model.gguf' }]);
    s3.getFile.mockResolvedValue(Buffer.from(m));
    const r = row({ id: 'r', slug: 'r', bucketPrefix: 'r/v/', manifestDigest: null });
    repo.findAll.mockResolvedValue([r]);

    await service.runInventory();

    expect(r.markAvailability).toHaveBeenCalledWith(AiModelAvailability.AVAILABLE, expect.anything(), expect.any(Date));
    expect(r.manifestDigest).toBe(sha256(m));
  });

  it('reports every manifest-bearing prefix no row references as unregistered (flat and HF-cache layouts)', async () => {
    s3.listFiles.mockResolvedValue([
      { key: 'medical-ner/abc/manifest.json' },
      { key: 'orphan-model/q4-0-123456789abc/manifest.json' },
      { key: 'orphan-model/q4-0-123456789abc/model.gguf' },
      { key: 'hf/hub/models--org--repo/snapshots/deadbeef/manifest.json' },
      { key: 'hf/hub/models--org--repo/refs/main' },
    ]);
    s3.getFile.mockImplementation(async (_b: string, key: string) => Buffer.from(manifest([], { slug: key.split('/')[0] === 'hf' ? 'repo' : key.split('/')[0] })));
    repo.findAll.mockResolvedValue([row({ bucketPrefix: 'medical-ner/abc/', manifestDigest: null })]);

    const report = await service.runInventory();

    expect(report.unregistered.map((u) => u.bucketPrefix).sort()).toEqual(['hf/hub/models--org--repo/snapshots/deadbeef/', 'orphan-model/q4-0-123456789abc/']);
    expect(report.unregistered.find((u) => u.bucketPrefix.startsWith('orphan'))?.slug).toBe('orphan-model');
  });

  it('a bucket listing failure marks nothing and surfaces as an error (never a false MISSING)', async () => {
    s3.listFiles.mockRejectedValue(new Error('minio down'));
    repo.findAll.mockResolvedValue([row({ bucketPrefix: 'x/y/' })]);

    await expect(service.runInventory()).rejects.toThrow('minio down');
    expect(repo.update).not.toHaveBeenCalled();
  });
});
