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
import { AiDeploymentKind, AiModelAvailability, AiModelSource, SYSTEM_TENANT_ID } from '@arcaai/domains';
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
    source: AiModelSource.HUGGINGFACE,
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

/**
 * TASK-960 OD-1 — a LOCAL row is verified by OBJECT LISTING, never by a
 * `manifest.json`.
 *
 * A LOCAL model is one an admin uploaded into `hope-models` through the MinIO
 * browser; the bucket is mounted into every serving pod, so the weights are
 * already where the loader looks. Nothing downloaded them, so nothing wrote a
 * manifest — and demanding one stamped every correct upload `MISSING` forever.
 *
 * The corollary is that a LOCAL row can never be `PARTIAL`: `PARTIAL` means
 * "the manifest and the bucket disagree", and a row with no manifest of its own
 * has no digest that could drift.
 */
describe('ModelInventoryService.runInventory — a LOCAL row is verified by listing', () => {
  const s3 = { listFiles: vi.fn(), getFile: vi.fn() };
  const repo = { findAll: vi.fn(), update: vi.fn(async (_id: string, e: unknown) => e) };
  const db = { baseClient: BASE_CLIENT };
  let service: ModelInventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ModelInventoryService(repo as never, s3 as never, db as never);
  });

  it('is AVAILABLE when its primaryObject is present under the prefix, and never opens the manifest', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'arcaai-whisper-en-2609/ggml-arcaai-whisper-en-2609-f16.bin', size: 1620000000 }]);
    const local = row({
      id: 'l',
      slug: 'arcaai-whisper-2609',
      source: AiModelSource.LOCAL,
      libraryName: 'whisper-cpp',
      bucketPrefix: 'arcaai-whisper-en-2609/',
      primaryObject: 'ggml-arcaai-whisper-en-2609-f16.bin',
    });
    repo.findAll.mockResolvedValue([local]);

    const report = await service.runInventory();

    expect(local.markAvailability).toHaveBeenCalledWith(AiModelAvailability.AVAILABLE, expect.objectContaining({ verifiedBy: 'listing', bucketPrefix: 'arcaai-whisper-en-2609/' }), expect.any(Date));
    expect(s3.getFile).not.toHaveBeenCalled();
    expect(report.counts.available).toBe(1);
  });

  it('is MISSING, naming the object, when its primaryObject is absent from the listing', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'staged/other.bin' }]);
    const local = row({
      id: 'l',
      slug: 'staged',
      source: AiModelSource.LOCAL,
      bucketPrefix: 'staged/',
      primaryObject: 'weights.bin',
    });
    repo.findAll.mockResolvedValue([local]);

    const report = await service.runInventory();

    expect(local.markAvailability).toHaveBeenCalledWith(AiModelAvailability.MISSING, expect.objectContaining({ reason: expect.stringContaining('weights.bin'), missingObjects: ['weights.bin'] }), expect.any(Date));
    expect(report.counts.missing).toBe(1);
  });

  it('is AVAILABLE with no primaryObject when the prefix holds at least one object', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'dir-model/v1/config.json' }, { key: 'dir-model/v1/model.safetensors' }]);
    const local = row({ id: 'l', slug: 'dir-model', source: AiModelSource.LOCAL, bucketPrefix: 'dir-model/v1/', primaryObject: null });
    repo.findAll.mockResolvedValue([local]);

    await service.runInventory();

    expect(local.markAvailability).toHaveBeenCalledWith(AiModelAvailability.AVAILABLE, expect.objectContaining({ verifiedBy: 'listing', objectsChecked: 2 }), expect.any(Date));
  });

  it('is MISSING when the prefix holds no objects at all', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'somewhere-else/model.gguf' }]);
    const local = row({ id: 'l', slug: 'empty', source: AiModelSource.LOCAL, bucketPrefix: 'empty/', primaryObject: null });
    repo.findAll.mockResolvedValue([local]);

    const report = await service.runInventory();

    expect(local.markAvailability).toHaveBeenCalledWith(AiModelAvailability.MISSING, expect.objectContaining({ reason: expect.stringContaining('empty/') }), expect.any(Date));
    expect(report.counts.missing).toBe(1);
    expect(report.counts.partial).toBe(0);
  });

  it('is never PARTIAL for a digest mismatch — a manifest it does not own cannot drift it', async () => {
    // The prefix happens to carry a manifest AND the row carries a stale digest:
    // the manifest lane would stamp PARTIAL. Listing verification does not read it.
    s3.listFiles.mockResolvedValue([{ key: 'mixed/manifest.json' }, { key: 'mixed/model.gguf' }]);
    s3.getFile.mockResolvedValue(Buffer.from(manifest(['model.gguf', 'absent.gguf'])));
    const local = row({ id: 'l', slug: 'mixed', source: AiModelSource.LOCAL, bucketPrefix: 'mixed/', manifestDigest: 'stale-digest', primaryObject: 'model.gguf' });
    repo.findAll.mockResolvedValue([local]);

    const report = await service.runInventory();

    expect(local.markAvailability).toHaveBeenCalledWith(AiModelAvailability.AVAILABLE, expect.anything(), expect.any(Date));
    expect(s3.getFile).not.toHaveBeenCalled();
    expect(report.counts.partial).toBe(0);
  });

  it('keeps the cloud and weight-less short-circuits ahead of the LOCAL branch', async () => {
    s3.listFiles.mockResolvedValue([]);
    const cloudLocal = row({ id: 'c', slug: 'c', source: AiModelSource.LOCAL, deploymentKind: AiDeploymentKind.CLOUD, bucketPrefix: 'c/' });
    const weightlessLocal = row({ id: 'w', slug: 'w', source: AiModelSource.LOCAL, libraryName: 'pyrnnoise', bucketPrefix: 'w/' });
    repo.findAll.mockResolvedValue([cloudLocal, weightlessLocal]);

    const report = await service.runInventory();

    expect(cloudLocal.markAvailability).toHaveBeenCalledWith(AiModelAvailability.NOT_APPLICABLE, expect.anything(), expect.any(Date));
    expect(weightlessLocal.markAvailability).toHaveBeenCalledWith(AiModelAvailability.NOT_APPLICABLE, expect.anything(), expect.any(Date));
    expect(report.counts.notApplicable).toBe(2);
  });
});

/**
 * TASK-960 — "In bucket, not registered" must see an ADMIN UPLOAD.
 *
 * Before this, discovery listed only prefixes that already carried a
 * `manifest.json` AND matched `<slug>/<version>/` — precisely the prefixes the
 * publisher itself wrote, which are exactly the ones that need no adopting. A
 * staged upload (one segment deep, no manifest) was invisible.
 */
describe('ModelInventoryService.runInventory — staged (manifest-less) prefixes are discoverable', () => {
  const s3 = { listFiles: vi.fn(), getFile: vi.fn() };
  const repo = { findAll: vi.fn(async () => []), update: vi.fn(async (_id: string, e: unknown) => e) };
  const db = { baseClient: BASE_CLIENT };
  let service: ModelInventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findAll.mockResolvedValue([]);
    service = new ModelInventoryService(repo as never, s3 as never, db as never);
  });

  it('reports a one-segment manifest-less prefix holding a weight file as `staged`', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'arcaai-whisper-en-2609/ggml-arcaai-whisper-en-2609-f16.bin', size: 1620000000 }]);

    const report = await service.runInventory();

    expect(report.unregistered).toEqual([
      expect.objectContaining({
        bucketPrefix: 'arcaai-whisper-en-2609/',
        layout: 'staged',
        slug: 'arcaai-whisper-en-2609',
        version: null,
        objectCount: 1,
        totalBytes: 1620000000,
      }),
    ]);
    expect(s3.getFile).not.toHaveBeenCalled();
  });

  it('groups a two-segment staged prefix by its directory and names its version', async () => {
    s3.listFiles.mockResolvedValue([
      { key: 'staged-model/f16/model.safetensors', size: 10 },
      { key: 'staged-model/f16/config.json', size: 2 },
    ]);

    const report = await service.runInventory();

    expect(report.unregistered).toEqual([
      expect.objectContaining({ bucketPrefix: 'staged-model/f16/', layout: 'staged', slug: 'staged-model', version: 'f16', objectCount: 2, totalBytes: 12 }),
    ]);
  });

  it('never reports the hf/ cache tree, which is full of manifest-less weights', async () => {
    s3.listFiles.mockResolvedValue([
      { key: 'hf/hub/models--blaze999--Medical-NER/snapshots/deadbeef/model.safetensors' },
      { key: 'hf/hub/models--blaze999--Medical-NER/refs/main' },
    ]);

    const report = await service.runInventory();

    expect(report.unregistered).toEqual([]);
  });

  it('leaves out a prefix a catalogue row already references, and any directory under it', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'adopted/model.gguf' }, { key: 'adopted/extra/shard.gguf' }]);
    repo.findAll.mockResolvedValue([row({ id: 'a', slug: 'adopted', source: AiModelSource.LOCAL, bucketPrefix: 'adopted/', primaryObject: 'model.gguf' })]);

    const report = await service.runInventory();

    expect(report.unregistered).toEqual([]);
  });

  it('leaves out a subdirectory of a published, manifest-bearing prefix', async () => {
    s3.listFiles.mockResolvedValue([
      { key: 'published/v1/manifest.json' },
      { key: 'published/v1/model.gguf' },
      { key: 'published/v1/shards/part-1.gguf' },
    ]);
    s3.getFile.mockResolvedValue(Buffer.from(manifest(['model.gguf'], { slug: 'published', version: 'v1' })));

    const report = await service.runInventory();

    expect(report.unregistered.map((u) => u.bucketPrefix)).toEqual(['published/v1/']);
    expect(report.unregistered[0]?.layout).toBe('flat');
  });

  it('ignores a manifest-less prefix that holds no weight file at all', async () => {
    s3.listFiles.mockResolvedValue([{ key: 'notes/README.md' }, { key: 'notes/config.json' }]);

    const report = await service.runInventory();

    expect(report.unregistered).toEqual([]);
  });
});
