/**
 * TASK-1023 — registering a model from a path already in the models bucket.
 *
 *   B2 `previewLocal(path)` derives everything from the bucket: layout, snapshot revision,
 *      primary object for single-file loaders, and — from `config.json` — architecture and
 *      compute type; an empty prefix is 404 PATH_EMPTY; a file path registers its folder.
 *   B3 `registerFromPath` creates a SYSTEM row with source LOCAL, SELF_HOSTED and the derived
 *      `s3://hope-models/<prefix>` source URI; a taken slug is 409 SLUG_TAKEN; a super admin with a
 *      working tenant is 403.
 *
 * Boundaries mocked: the bucket (IS3Service), repository, AiModelService, event emitter, CLS.
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelPathRegistrationService } from '../model-path-registration.service';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SNAPSHOT = `hf/hub/models--blaze999--Medical-NER/snapshots/${SHA}/`;
const GiB = 1024 ** 3;

type Bucket = Record<string, { size: number; body?: string }>;

const DEFAULT_BUCKET: Bucket = {
  [`${SNAPSHOT}config.json`]: {
    size: 700,
    body: JSON.stringify({ architectures: ['DebertaV2ForTokenClassification'], torch_dtype: 'float32', model_type: 'deberta-v2' }),
  },
  [`${SNAPSHOT}model.safetensors`]: { size: 700_000_000 },
  [`${SNAPSHOT}tokenizer.json`]: { size: 2_000_000 },
  'hf/hub/models--blaze999--Medical-NER/refs/main': { size: 40 },
  'qwen3-4b/0123abcd/manifest.json': { size: 400, body: '{"slug":"qwen3-4b"}' },
  'qwen3-4b/0123abcd/Qwen3-4B-Q4_K_M.gguf': { size: 2_500_000_000 },
  'whisper-ml/': { size: 0 },
  'whisper-ml/ggml-large-v3-q5_0.bin': { size: 1_080_000_000 },
  'whisper-ml/README.md': { size: 1_000 },
  'whisper-mlx/other.bin': { size: 10 },
  'two-ggufs/a.gguf': { size: 10 },
  'two-ggufs/b.gguf': { size: 10 },
  'vllm-asr/config.json': { size: 100, body: JSON.stringify({ architectures: ['WhisperForConditionalGeneration'], torch_dtype: 'float16' }) },
  'vllm-asr/model.safetensors': { size: 3 * GiB - 100 },
  'root-file.gguf': { size: 10 },
};

function build(opts: { roles?: string[]; tenantId?: string | null; bucket?: Bucket; bySlug?: unknown } = {}) {
  const bucket = opts.bucket ?? DEFAULT_BUCKET;
  const s3 = {
    listFiles: vi.fn(async (_bucket: string, prefix: string) =>
      Object.entries(bucket)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.size })),
    ),
    getFile: vi.fn(async (_bucket: string, key: string) => {
      const entry = bucket[key];
      if (!entry) throw new Error(`NoSuchKey ${key}`);
      return Buffer.from(entry.body ?? '');
    }),
  };
  const created: Record<string, unknown> = {};
  const row = { id: 'm-1', tenantId: SYSTEM_TENANT_ID, slug: 'x', metaData: undefined as Record<string, unknown> | undefined, version: 1 };
  const repo = {
    findBySlug: vi.fn(async () => opts.bySlug ?? null),
    findAll: vi.fn(async () => (opts.bySlug ? [opts.bySlug] : [])),
    // The real repository returns the row `create` just wrote.
    findById: vi.fn(async () => Object.assign(row, created)),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const aiModelService = {
    create: vi.fn(async (dto: Record<string, unknown>) => {
      Object.assign(created, dto);
      return { id: 'm-1', ...dto };
    }),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'admin-1', roles: opts.roles ?? ['SUPER_ADMIN'] };
      if (key === 'tenantId') return opts.tenantId ?? null;
      return null;
    }),
  };
  const events = { emit: vi.fn() };
  const svc = new ModelPathRegistrationService(aiModelService as never, repo as never, s3 as never, events as never, cls as never);
  return { svc, s3, repo, aiModelService, row };
}

// ─── B2 ──────────────────────────────────────────────────────────────────────

describe('B2 — previewLocal', () => {
  it('an HF snapshot dir → hf-cache layout, the snapshot sha, classification from config.json', async () => {
    const { svc } = build();
    const preview = await svc.previewLocal(`/mnt/models-bucket/${SNAPSHOT}`);

    expect(preview).toMatchObject({
      bucketPrefix: SNAPSHOT,
      localPath: `/mnt/models-bucket/${SNAPSHOT}`,
      primaryObject: null,
      layout: 'hf-cache',
      revision: SHA,
      totalBytes: 702_000_700,
      suggested: {
        slug: 'medical-ner',
        name: 'Medical-NER',
        taskType: ModelTaskType.TOKEN_CLASSIFICATION,
        libraryName: 'transformers',
        format: AiModelFormat.SAFETENSOR,
        servedBy: 'nlp',
        architecture: 'DebertaV2ForTokenClassification',
        computeType: 'float32',
      },
    });
    expect(preview.files.map((f) => f.key).sort()).toEqual(['config.json', 'model.safetensors', 'tokenizer.json']);
  });

  it('a flat GGUF prefix (manifest.json present) → llama.cpp, primaryObject = the .gguf', async () => {
    const { svc } = build();
    const preview = await svc.previewLocal('hope-models/qwen3-4b/0123abcd');

    expect(preview).toMatchObject({
      bucketPrefix: 'qwen3-4b/0123abcd/',
      layout: 'flat',
      primaryObject: 'Qwen3-4B-Q4_K_M.gguf',
      localPath: '/mnt/models-bucket/qwen3-4b/0123abcd/Qwen3-4B-Q4_K_M.gguf',
      revision: null,
      suggested: {
        slug: 'qwen3-4b',
        libraryName: 'llama.cpp',
        format: AiModelFormat.GGUF,
        taskType: ModelTaskType.TEXT_GENERATION,
        servedBy: 'lmstudio',
      },
    });
  });

  it('a folder holding ggml-*.bin → whisper.cpp, files layout, never a sibling folder with the same stem', async () => {
    const { svc } = build();
    const preview = await svc.previewLocal('s3://hope-models/whisper-ml/');

    expect(preview).toMatchObject({
      bucketPrefix: 'whisper-ml/',
      layout: 'files',
      primaryObject: 'ggml-large-v3-q5_0.bin',
      suggested: {
        slug: 'whisper-ml',
        libraryName: 'whisper.cpp',
        format: AiModelFormat.WHISPER_CPP,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        servedBy: 'stt',
      },
    });
    expect(preview.files.map((f) => f.key).sort()).toEqual(['README.md', 'ggml-large-v3-q5_0.bin']);
  });

  it('a FILE path → its folder is the prefix and the file is the primary object', async () => {
    const { svc } = build();
    const preview = await svc.previewLocal('/mnt/models-bucket/two-ggufs/b.gguf');

    expect(preview).toMatchObject({ bucketPrefix: 'two-ggufs/', primaryObject: 'b.gguf', localPath: '/mnt/models-bucket/two-ggufs/b.gguf' });
  });

  it('two candidate files and no file named → primaryObject null (ambiguous)', async () => {
    const { svc } = build();
    expect((await svc.previewLocal('two-ggufs')).primaryObject).toBeNull();
  });

  it('nothing under the prefix → 404 PATH_EMPTY', async () => {
    const { svc } = build();
    await expect(svc.previewLocal('does-not-exist/')).rejects.toMatchObject({ status: 404, response: { code: 'PATH_EMPTY' } });
  });

  it('a file at the bucket root has no folder to register → 400 PATH_INVALID', async () => {
    const { svc } = build();
    await expect(svc.previewLocal('root-file.gguf')).rejects.toMatchObject({ status: 400, response: { code: 'PATH_INVALID' } });
  });

  it('a traversal segment → 400 PATH_INVALID, the bucket is never read', async () => {
    const { svc, s3 } = build();
    await expect(svc.previewLocal('a/../b')).rejects.toMatchObject({ status: 400, response: { code: 'PATH_INVALID' } });
    expect(s3.listFiles).not.toHaveBeenCalled();
  });

  it('tenant admin → 403, nothing read', async () => {
    const { svc, s3 } = build({ roles: ['TENANT_ADMIN'] });
    await expect(svc.previewLocal('whisper-ml/')).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.listFiles).not.toHaveBeenCalled();
  });
});

// ─── B3 ──────────────────────────────────────────────────────────────────────

describe('B3 — registerFromPath', () => {
  it('creates source LOCAL, SELF_HOSTED, with the derived bucket prefix, primary object and s3:// source URI', async () => {
    const { svc, aiModelService } = build();
    const model = await svc.registerFromPath({ path: '/mnt/models-bucket/whisper-ml/' });

    expect(aiModelService.create).toHaveBeenCalledTimes(1);
    expect(aiModelService.create.mock.calls[0][0]).toMatchObject({
      name: 'whisper-ml',
      slug: 'whisper-ml',
      source: AiModelSource.LOCAL,
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      sourceUri: 's3://hope-models/whisper-ml',
      bucketPrefix: 'whisper-ml/',
      primaryObject: 'ggml-large-v3-q5_0.bin',
      format: AiModelFormat.WHISPER_CPP,
      libraryName: 'whisper.cpp',
      servedBy: 'stt',
      taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
      category: ModelCategory.AUDIO,
      modelType: ModelType.QUANTIZED_MODEL,
      provider: 'built-in',
    });
    expect(model).toMatchObject({ id: 'm-1', slug: 'whisper-ml' });
  });

  it('an HF snapshot records its sha as hfRevision; a multi-file library stores no primary object', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromPath({ path: SNAPSHOT });
    const dto = aiModelService.create.mock.calls[0][0] as Record<string, unknown>;
    expect(dto).toMatchObject({
      hfRevision: SHA,
      bucketPrefix: SNAPSHOT,
      sourceUri: `s3://hope-models/${SNAPSHOT.slice(0, -1)}`,
      architecture: 'DebertaV2ForTokenClassification',
    });
    expect(dto.primaryObject).toBeUndefined();
  });

  it('overrides win over what the preview suggests', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromPath({ path: 'whisper-ml/', slug: 'whisper-ml-en', name: 'Whisper ML', servedBy: 'stt-worker' });
    expect(aiModelService.create.mock.calls[0][0]).toMatchObject({ slug: 'whisper-ml-en', name: 'Whisper ML', servedBy: 'stt-worker' });
  });

  it('a slug the admin names that is taken → 409 SLUG_TAKEN, nothing created', async () => {
    const { svc, aiModelService } = build({ bySlug: { id: 'other', slug: 'taken' } });
    await expect(svc.registerFromPath({ path: 'whisper-ml/', slug: 'taken' })).rejects.toMatchObject({ status: 409, response: { code: 'SLUG_TAKEN' } });
    expect(aiModelService.create).not.toHaveBeenCalled();
  });

  it('nothing inferable for the serving workload → 400 SERVED_BY_REQUIRED', async () => {
    const { svc, aiModelService } = build({ bucket: { 'onnx-thing/model.onnx': { size: 10 } } });
    await expect(svc.registerFromPath({ path: 'onnx-thing/' })).rejects.toMatchObject({ status: 400, response: { code: 'SERVED_BY_REQUIRED' } });
    expect(aiModelService.create).not.toHaveBeenCalled();
  });

  it('a single-file library with no single candidate file → 400 PRIMARY_OBJECT_REQUIRED', async () => {
    const { svc, aiModelService } = build();
    await expect(svc.registerFromPath({ path: 'two-ggufs/' })).rejects.toMatchObject({ status: 400, response: { code: 'PRIMARY_OBJECT_REQUIRED' } });
    expect(aiModelService.create).not.toHaveBeenCalled();
  });

  it('super admin WITH a working tenant → 403, nothing read', async () => {
    const { svc, s3 } = build({ tenantId: '50000000-0000-0000-0000-000000000000' });
    await expect(svc.registerFromPath({ path: 'whisper-ml/' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(s3.listFiles).not.toHaveBeenCalled();
  });

  // B5 on the path route
  it('a vLLM-served registration writes the derived vramGiB default; others are not touched', async () => {
    const vllm = build();
    await vllm.svc.registerFromPath({ path: 'vllm-asr/', servedBy: 'vllm' });
    expect(vllm.repo.updateWithVersion).toHaveBeenCalledTimes(1);
    const written = vllm.repo.updateWithVersion.mock.calls[0][1] as { metaData: Record<string, unknown> };
    expect(written.metaData.serving).toEqual({ vramGiB: 5, derived: true }); // 3 GiB → 3.75 + 1 → 5

    const stt = build();
    await stt.svc.registerFromPath({ path: 'vllm-asr/' });
    // One write still happens (availability, FU-12) — but it carries no serving facts.
    const sttWritten = stt.repo.updateWithVersion.mock.calls[0][1] as { metaData?: Record<string, unknown> };
    expect(sttWritten.metaData?.serving).toBeUndefined();
  });
});

// ─── Cluster e2e findings (2026-10-01) ───────────────────────────────────────
describe('registerFromPath — LM Studio wire id (FU-11) and availability (FU-12)', () => {
  it('a GGUF served by LM Studio derives wireModelId the way link-models names the directory', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromPath({ path: 'qwen3-4b/0123abcd/' });
    expect(aiModelService.create).toHaveBeenCalledWith(expect.objectContaining({ servedBy: 'lmstudio', wireModelId: 'qwen3-4b' }));
  });

  it('strips the -gguf suffix of the bucket directory', async () => {
    const bucket = { 'gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16/gemma.gguf': { size: 10 } };
    const { svc, aiModelService } = build({ bucket });
    await svc.registerFromPath({ path: '/mnt/models-bucket/gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16/' });
    expect(aiModelService.create).toHaveBeenCalledWith(expect.objectContaining({ wireModelId: 'gemma-4-e2b-it-qat' }));
  });

  it('an embedding model gets the text-embedding- prefix LM Studio adds back', async () => {
    const bucket = { 'text-embedding-embeddinggemma-300m-qat-gguf/v1/e.gguf': { size: 10 } };
    const { svc, aiModelService } = build({ bucket });
    await svc.registerFromPath({ path: 'text-embedding-embeddinggemma-300m-qat-gguf/v1/', taskType: 'FEATURE_EXTRACTION' });
    expect(aiModelService.create).toHaveBeenCalledWith(expect.objectContaining({ wireModelId: 'text-embedding-embeddinggemma-300m-qat' }));
  });

  it('a row not served by LM Studio gets no wireModelId', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromPath({ path: 'whisper-ml/' });
    expect(aiModelService.create.mock.calls[0][0]).not.toHaveProperty('wireModelId');
  });

  it('the files were just listed, so the row is AVAILABLE at once (not UNKNOWN until the hourly inventory)', async () => {
    const { svc, repo } = build();
    await svc.registerFromPath({ path: 'whisper-ml/' });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    const saved = repo.updateWithVersion.mock.calls[0][1] as { availability?: string; availabilityCheckedAt?: Date };
    expect(saved.availability).toBe('AVAILABLE');
    expect(saved.availabilityCheckedAt).toBeInstanceOf(Date);
  });
});
