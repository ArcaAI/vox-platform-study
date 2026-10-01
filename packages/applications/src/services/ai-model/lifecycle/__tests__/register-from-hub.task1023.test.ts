/**
 * TASK-1023 — registering from Hugging Face needs nothing but the repo id.
 *
 *   B4 `register-from-hub { repoId }` alone: name, slug, task, library, format, served-by derived
 *      from the preview; the revision defaults to `main` and the row pins the commit it resolves to.
 *   B5 a vLLM-served registration gets the derived `_metadata.serving.vramGiB` (OD-9), written in
 *      the same update that claims the download; no other row gets one.
 *
 * Boundaries mocked: repository, queue, Hub client, AiModelService, event emitter, CLS.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiDeploymentKind, AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelRegistryOperationsService } from '../model-registry-operations.service';

const GiB = 1024 ** 3;

function build(opts: { pipelineTag?: string | null; libraryName?: string | null; files?: Array<{ path: string; size: number }> } = {}) {
  const row = {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'whisper-large-v3',
    source: AiModelSource.HUGGINGFACE,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null as Record<string, unknown> | null,
    version: 1,
    updatedBy: null,
  };
  const repo = {
    findById: vi.fn(async () => row),
    findBySlug: vi.fn(async () => null),
    findAll: vi.fn(async () => []),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const aiModelService = {
    create: vi.fn(async (dto: { slug: string; servedBy: string }) => ({ id: 'm-1', slug: dto.slug, servedBy: dto.servedBy })),
  };
  const hub = {
    getRepoInfo: vi.fn().mockResolvedValue({
      sha: '0123456789abcdef0123456789abcdef01234567',
      gated: false,
      license: 'apache-2.0',
      pipelineTag: opts.pipelineTag === undefined ? 'automatic-speech-recognition' : opts.pipelineTag,
      libraryName: opts.libraryName === undefined ? 'transformers' : opts.libraryName,
      languages: ['en'],
    }),
    listRepoFiles: vi.fn().mockResolvedValue(
      opts.files ?? [
        { path: 'config.json', size: 1_000 },
        { path: 'model.safetensors', size: 3 * GiB - 1_000 },
      ],
    ),
  };
  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : null)),
  };
  const svc = new ModelRegistryOperationsService(
    aiModelService as never,
    repo as never,
    hub as never,
    { referrersOf: vi.fn().mockResolvedValue([]) } as never,
    queue as never,
    { emit: vi.fn() } as never,
    cls as never,
    undefined,
    { findDefaultRow: vi.fn().mockResolvedValue(null) } as never,
    undefined,
  );
  return { svc, repo, queue, aiModelService, hub };
}

describe('B4 — register-from-hub with the repo id alone', () => {
  it('derives every registry field and pins the commit `main` resolves to', async () => {
    const { svc, aiModelService, hub, queue } = build();

    const out = await svc.registerFromHub({ repoId: 'openai/whisper-large-v3' });

    expect(hub.getRepoInfo).toHaveBeenCalledWith('openai/whisper-large-v3', 'main');
    expect(aiModelService.create).toHaveBeenCalledTimes(1);
    expect(aiModelService.create.mock.calls[0][0]).toMatchObject({
      name: 'whisper-large-v3',
      slug: 'whisper-large-v3',
      category: ModelCategory.AUDIO,
      taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
      source: AiModelSource.HUGGINGFACE,
      sourceUri: 'hf:openai/whisper-large-v3',
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      provider: 'built-in',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ model: { id: 'm-1', slug: 'whisper-large-v3' }, jobId: expect.any(String) });
  });

  it('a repo whose task cannot be inferred is 400 SERVED_BY_REQUIRED, nothing created', async () => {
    const { svc, aiModelService } = build({ pipelineTag: null });
    await expect(svc.registerFromHub({ repoId: 'o/n' })).rejects.toMatchObject({ response: { code: 'SERVED_BY_REQUIRED' } });
    expect(aiModelService.create).not.toHaveBeenCalled();
  });
});

describe('B5 — the derived vramGiB default on a Hub registration', () => {
  it('a vLLM-served registration writes serving.vramGiB = ceil(GiB × 1.25 + 1), derived, in the download claim', async () => {
    const { svc, repo } = build();

    await svc.registerFromHub({ repoId: 'openai/whisper-large-v3', servedBy: 'vllm' });

    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    const written = repo.updateWithVersion.mock.calls[0][1] as { metaData: Record<string, unknown> };
    // 3 GiB of files → 3.75 + 1 → 5
    expect(written.metaData.serving).toEqual({ vramGiB: 5, derived: true });
    expect(written.metaData.download).toMatchObject({ jobId: expect.any(String) });
  });

  it('a row served by anything else gets no serving facts', async () => {
    const { svc, repo } = build();

    await svc.registerFromHub({ repoId: 'openai/whisper-large-v3' });

    const written = repo.updateWithVersion.mock.calls[0][1] as { metaData: Record<string, unknown> };
    expect(written.metaData.serving).toBeUndefined();
  });
});

// ─── Cluster e2e finding FU-11 (2026-10-01) ──────────────────────────────────
describe('register-from-hub — an LM Studio GGUF gets the wire id link-models will give it', () => {
  const ggufFiles = [{ path: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', size: 1_100_000_000 }];

  it('a GGUF repo served by LM Studio: wireModelId = the slug (its flat bucket directory) without -gguf', async () => {
    const { svc, aiModelService } = build({ pipelineTag: 'text-generation', libraryName: 'gguf', files: ggufFiles });
    await svc.registerFromHub({ repoId: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', servedBy: 'lmstudio' });
    const dto = aiModelService.create.mock.calls[0][0] as { slug: string; wireModelId?: string; provider?: string };
    expect(dto.provider).toBe('lm-studio');
    expect(dto.wireModelId).toBe(dto.slug.replace(/-gguf$/, ''));
  });

  it('a row not served by LM Studio gets no wireModelId', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromHub({ repoId: 'openai/whisper-large-v3' });
    expect(aiModelService.create.mock.calls[0][0]).not.toHaveProperty('wireModelId');
  });
});
