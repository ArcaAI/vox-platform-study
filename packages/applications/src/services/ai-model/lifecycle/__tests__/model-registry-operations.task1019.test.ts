/**
 * TASK-1019 — platform-admin operations on the model registry.
 *
 *   R1 hub preview maps the card; gated / private without a platform token → 422 HF_TOKEN_REQUIRED; unknown → 404
 *   R2 register-from-hub creates the SYSTEM row through `AiModelService.create` and enqueues ONE download; slug taken → 409
 *   R3 every method: tenant admin 403, super admin with a working tenant 403
 *   R4 unregister with all six referrer kinds → 409 MODEL_IN_USE listing them with tenant ids; nothing enqueued
 *   R5 unregister unloads per service first; still loaded → 409 MODEL_UNLOAD_FAILED; unloaded → UNREGISTERING + one job
 *   R7 download-missing enqueues SYSTEM SELF_HOSTED rows that are not on disk (MISSING, UNKNOWN or PARTIAL) with a
 *      fetchable source; skips DOWNLOADING / UNREGISTERING / unfetchable
 *
 * Boundaries mocked: repositories, queue, Hub client, residency port, AiModelService, event emitter, CLS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  AgentTask,
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  JobQueue,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ModelRegistryOperationsService } from '../model-registry-operations.service';
import { ModelUsageReader } from '../model-usage.reader';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function cls(opts: { roles?: string[]; tenantId?: string | null } = {}) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'admin-1', roles: opts.roles ?? ['SUPER_ADMIN'] };
      if (key === 'tenantId') return opts.tenantId ?? null;
      return null;
    }),
  };
}

function modelRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'medical-ner',
    name: 'Medical NER',
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'hf:blaze999/Medical-NER',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    servedBy: 'nlp',
    provider: 'built-in',
    availability: AiModelAvailability.AVAILABLE,
    bucketPrefix: 'hf/hub/models--blaze999--Medical-NER/snapshots/abc/',
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null as Record<string, unknown> | null,
    version: 7,
    updatedBy: null,
    ...over,
  };
}

function emptyUsage() {
  return { referrersOf: vi.fn().mockResolvedValue([]) };
}

function catalogueWith(entries: Array<{ service: string; status: string; modelRef?: string }>) {
  return {
    reportedAt: '2026-09-29T10:00:00Z',
    services: ['stt', 'stt-worker', 'lm-studio', 'nlp'].map((service) => ({
      service,
      models: entries
        .filter((e) => e.service === service)
        .map((e) => ({ aiModelId: 'm-1', slug: 'medical-ner', modelRef: e.modelRef ?? 'blaze999/Medical-NER', status: e.status })),
    })),
  };
}

interface BuildOpts {
  roles?: string[];
  tenantId?: string | null;
  row?: ReturnType<typeof modelRow> | null;
  rows?: Array<ReturnType<typeof modelRow>>;
  sharing?: Array<ReturnType<typeof modelRow>>;
  usage?: { referrersOf: ReturnType<typeof vi.fn> };
  residency?: { getCatalogue: ReturnType<typeof vi.fn>; unload: ReturnType<typeof vi.fn> };
  token?: boolean;
  hub?: { getRepoInfo: ReturnType<typeof vi.fn>; listRepoFiles: ReturnType<typeof vi.fn> };
  bySlug?: unknown;
  settings?: Record<string, unknown>;
}

function build(opts: BuildOpts = {}) {
  const row = opts.row === undefined ? modelRow() : opts.row;
  const repo = {
    findById: vi.fn(async () => {
      if (!row) throw new DataNotFoundException('aiModel', 'x');
      return row;
    }),
    findBySlug: vi.fn(async () => opts.bySlug ?? null),
    findAll: vi.fn(async (props: { filters: Record<string, unknown> }) => {
      if ('slug' in props.filters) return opts.bySlug ? [opts.bySlug] : [];
      if ('bucketPrefix' in props.filters) return opts.sharing ?? [];
      return opts.rows ?? [];
    }),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const aiModelService = { create: vi.fn(async (dto: { slug: string }) => ({ id: 'm-1', slug: dto.slug })) };
  const hub = opts.hub ?? {
    getRepoInfo: vi.fn().mockResolvedValue({
      sha: 'c0ffee',
      gated: false,
      license: 'apache-2.0',
      pipelineTag: 'token-classification',
      libraryName: 'transformers',
      languages: ['en'],
    }),
    listRepoFiles: vi.fn().mockResolvedValue([
      { path: 'config.json', size: 1_000 },
      { path: 'model.safetensors', size: 499_000 },
    ]),
  };
  const tokenPort = { findDefaultRow: vi.fn().mockResolvedValue(opts.token ? { enabled: true, encryptedApiKey: new Uint8Array([1, 2]) } : null) };
  const events = { emit: vi.fn() };
  const svc = new ModelRegistryOperationsService(
    aiModelService as never,
    repo as never,
    hub as never,
    (opts.usage ?? emptyUsage()) as never,
    queue as never,
    events as never,
    cls(opts) as never,
    opts.residency as never,
    tokenPort as never,
    (opts.settings
      ? { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in opts.settings! ? opts.settings![key] : fallback)) }
      : undefined) as never,
  );
  return { svc, repo, queue, aiModelService, hub, row };
}

// ─── R3 ──────────────────────────────────────────────────────────────────────

describe('R3 — every operation is a tenant-less platform-admin action', () => {
  const calls: Array<[string, (s: ModelRegistryOperationsService) => Promise<unknown>]> = [
    ['previewHub', (s) => s.previewHub({ repoId: 'o/n' })],
    ['registerFromHub', (s) => s.registerFromHub({ repoId: 'o/n' })],
    ['getUsage', (s) => s.getUsage('m-1')],
    ['unregister', (s) => s.unregister('m-1', {})],
    ['downloadMissing', (s) => s.downloadMissing()],
  ];

  for (const [name, call] of calls) {
    it(`${name}: tenant admin → 403, nothing read`, async () => {
      const { svc, repo, hub } = build({ roles: ['TENANT_ADMIN'] });
      await expect(call(svc)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.findById).not.toHaveBeenCalled();
      expect(repo.findAll).not.toHaveBeenCalled();
      expect(hub.getRepoInfo).not.toHaveBeenCalled();
    });

    it(`${name}: super admin with a working tenant → 403`, async () => {
      const { svc, repo } = build({ tenantId: '50000000-0000-0000-0000-000000000000' });
      await expect(call(svc)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.findById).not.toHaveBeenCalled();
    });
  }
});

// ─── R1 ──────────────────────────────────────────────────────────────────────

describe('R1 — hub preview', () => {
  it('maps the card: task, library, licence, gated, languages, sha, size, suggested slug / format / layout', async () => {
    const { svc, hub } = build();
    const preview = await svc.previewHub({ repoId: 'blaze999/Medical-NER' });

    expect(hub.getRepoInfo).toHaveBeenCalledWith('blaze999/Medical-NER', 'main');
    expect(preview).toMatchObject({
      repoId: 'blaze999/Medical-NER',
      revision: 'main',
      commitSha: 'c0ffee',
      sourceUri: 'hf:blaze999/Medical-NER',
      pipelineTag: 'token-classification',
      libraryName: 'transformers',
      license: 'apache-2.0',
      gated: false,
      languages: ['en'],
      baseModel: null,
      totalBytes: 500_000,
      fileCount: 2,
      taskType: ModelTaskType.TOKEN_CLASSIFICATION,
      suggestedSlug: 'medical-ner',
      suggestedName: 'Medical-NER',
      suggestedFormat: AiModelFormat.SAFETENSOR,
      layout: 'hf-cache',
      suggested: {
        category: ModelCategory.NLP,
        modelType: null,
        libraryName: 'transformers',
        servedBy: 'nlp',
        provider: 'built-in',
      },
    });
  });

  it('a GGUF LLM repo suggests llama.cpp, a flat layout, lm-studio and QUANTIZED_MODEL', async () => {
    const hub = {
      getRepoInfo: vi
        .fn()
        .mockResolvedValue({ sha: 's', gated: false, license: null, pipelineTag: 'text-generation', libraryName: null, languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([{ path: 'Qwen3-0.6B-Q8_0.gguf', size: 600 }]),
    };
    const { svc } = build({ hub });
    const preview = await svc.previewHub({ repoId: 'unsloth/Qwen3-0.6B-GGUF', revision: 'v1' });
    expect(hub.getRepoInfo).toHaveBeenCalledWith('unsloth/Qwen3-0.6B-GGUF', 'v1');
    expect(preview).toMatchObject({
      taskType: ModelTaskType.TEXT_GENERATION,
      suggestedSlug: 'qwen3-0-6b-gguf',
      suggestedFormat: AiModelFormat.GGUF,
      layout: 'flat',
      suggested: { libraryName: 'llama.cpp', servedBy: 'lmstudio', provider: 'lm-studio', modelType: ModelType.QUANTIZED_MODEL },
    });
  });

  it('a gated repo with no platform token → 422 HF_TOKEN_REQUIRED', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockResolvedValue({ sha: 's', gated: true, license: null, pipelineTag: null, libraryName: null, languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([]),
    };
    const { svc } = build({ hub, token: false });
    const error = await svc.previewHub({ repoId: 'pyannote/segmentation-3.0' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'HF_TOKEN_REQUIRED' });
  });

  it('a gated repo WITH a platform token previews', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockResolvedValue({ sha: 's', gated: true, license: null, pipelineTag: null, libraryName: null, languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([]),
    };
    const { svc } = build({ hub, token: true });
    await expect(svc.previewHub({ repoId: 'pyannote/segmentation-3.0' })).resolves.toMatchObject({ gated: true });
  });

  it('a Hub 401 (private, or unknown to an anonymous caller) with no token → 422 HF_TOKEN_REQUIRED', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockRejectedValue(new Error("HuggingFace rejected the request for 'o/n' (HTTP 401) — configure …")),
      listRepoFiles: vi.fn().mockResolvedValue([]),
    };
    const { svc } = build({ hub });
    const error = await svc.previewHub({ repoId: 'o/n' }).catch((e: unknown) => e);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'HF_TOKEN_REQUIRED' });
  });

  it('an unknown repo (Hub 404) → 404', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } })),
      listRepoFiles: vi.fn().mockResolvedValue([]),
    };
    const { svc } = build({ hub, token: true });
    await expect(svc.previewHub({ repoId: 'o/nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── R2 ──────────────────────────────────────────────────────────────────────

describe('R2 — register from hub', () => {
  it('creates the SYSTEM row via AiModelService.create (hf:<repo>, pinned sha) and enqueues exactly one download', async () => {
    const { svc, aiModelService, queue, repo } = build();
    const out = await svc.registerFromHub({ repoId: 'blaze999/Medical-NER', tags: ['ner'] });

    expect(aiModelService.create).toHaveBeenCalledTimes(1);
    const dto = aiModelService.create.mock.calls[0][0];
    expect(dto).toMatchObject({
      slug: 'medical-ner',
      name: 'Medical-NER',
      source: AiModelSource.HUGGINGFACE,
      sourceUri: 'hf:blaze999/Medical-NER',
      sourceRevision: 'c0ffee',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      taskType: ModelTaskType.TOKEN_CLASSIFICATION,
      category: ModelCategory.NLP,
      format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'nlp',
      license: 'apache-2.0',
      gated: false,
      languages: ['en'],
      tags: ['ner'],
    });
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, slug: { in: expect.arrayContaining(['medical-ner']) } }) }),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, payload, jobOpts] = queue.add.mock.calls[0];
    expect(name).toBe(JobQueue.DownloadAiModel);
    expect(payload).toMatchObject({ kind: 'download', aiModelId: 'm-1', tenantId: SYSTEM_TENANT_ID });
    expect(jobOpts).toMatchObject({ attempts: 3, backoff: { type: 'exponential' } });
    expect(out).toEqual({ model: { id: 'm-1', slug: 'medical-ner' }, jobId: payload.jobId });
  });

  it('overrides win over the suggestions', async () => {
    const { svc, aiModelService } = build();
    await svc.registerFromHub({
      repoId: 'blaze999/Medical-NER',
      slug: 'ner-v2',
      name: 'NER v2',
      servedBy: 'stt',
      modelType: ModelType.FINETUNED_MODEL,
    });
    expect(aiModelService.create.mock.calls[0][0]).toMatchObject({
      slug: 'ner-v2',
      name: 'NER v2',
      servedBy: 'stt',
      modelType: ModelType.FINETUNED_MODEL,
    });
  });

  it('a repo with no pipeline tag: the task the admin chose decides servedBy and category', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockResolvedValue({ sha: 'c0ffee', gated: false, license: null, pipelineTag: null, libraryName: 'transformers', languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([{ path: 'config.json', size: 1 }, { path: 'model.safetensors', size: 2 }]),
    };
    const { svc, aiModelService } = build({ hub });
    await svc.registerFromHub({ repoId: 'o/tiny-bert', taskType: ModelTaskType.TOKEN_CLASSIFICATION });
    expect(aiModelService.create.mock.calls[0][0]).toMatchObject({
      taskType: ModelTaskType.TOKEN_CLASSIFICATION,
      category: ModelCategory.NLP,
      servedBy: 'nlp',
    });
  });

  it('no servedBy given and none inferable → a named 400 SERVED_BY_REQUIRED, nothing created or enqueued', async () => {
    const hub = {
      getRepoInfo: vi.fn().mockResolvedValue({ sha: 'c0ffee', gated: false, license: null, pipelineTag: null, libraryName: 'transformers', languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([{ path: 'config.json', size: 1 }, { path: 'model.safetensors', size: 2 }]),
    };
    const { svc, aiModelService, queue } = build({ hub });
    const error = await svc.registerFromHub({ repoId: 'o/tiny-bert' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'SERVED_BY_REQUIRED' });
    expect(aiModelService.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a slug the admin names that is taken → 409 and nothing is created or enqueued', async () => {
    const { svc, aiModelService, queue } = build({ bySlug: modelRow({ slug: 'medical-ner' }) });
    const error = await svc.registerFromHub({ repoId: 'blaze999/Medical-NER', slug: 'medical-ner' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SLUG_TAKEN' });
    expect(aiModelService.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('runs the create validation: an unservable library suggestion with no override → 400, nothing created', async () => {
    const hub = {
      getRepoInfo: vi
        .fn()
        .mockResolvedValue({ sha: 's', gated: false, license: null, pipelineTag: 'image-classification', libraryName: 'timm', languages: [] }),
      listRepoFiles: vi.fn().mockResolvedValue([{ path: 'model.safetensors', size: 1 }]),
    };
    const { svc, aiModelService } = build({ hub });
    await expect(svc.registerFromHub({ repoId: 'timm/resnet50' })).rejects.toBeInstanceOf(BadRequestException);
    expect(aiModelService.create).not.toHaveBeenCalled();
  });
});

// ─── R4 ──────────────────────────────────────────────────────────────────────

describe('R4 — MODEL_IN_USE lists every referrer kind, across tenants', () => {
  function usageReader() {
    const agents = {
      findAll: vi.fn(async (props: { filters: Record<string, unknown> }) => {
        const f = props.filters;
        if (f.modelId === 'm-1') return [{ id: 'ag-1', tenantId: TENANT_A, name: 'Scribe', slug: 'scribe', versionNumber: 2 }];
        if (f.task === AgentTask.SPEECH_TO_TEXT)
          return [
            {
              id: 'ag-asr',
              tenantId: TENANT_B,
              name: 'Live ASR',
              slug: 'live-asr',
              versionNumber: 1,
              parameters: { audioFrontEnd: { diarization: { embeddingModelSlug: 'medical-ner' } } },
              compiledConfig: null,
            },
            { id: 'ag-other', tenantId: TENANT_B, name: 'Other', slug: 'other', versionNumber: 1, parameters: {}, compiledConfig: null },
          ];
        if (f.id) return [{ id: 'ag-fb', tenantId: TENANT_B, name: 'Summariser', slug: 'summariser', versionNumber: 4 }];
        return [];
      }),
    };
    const fallbacks = { findAll: vi.fn().mockResolvedValue([{ id: 'fb-1', tenantId: TENANT_B, agentId: 'ag-fb', priority: 1 }]) };
    const routing = { findAll: vi.fn().mockResolvedValue([{ id: 'rp-1', tenantId: SYSTEM_TENANT_ID, displayName: null, taskKey: 'nlp.ner' }]) };
    const residencyPolicies = { findAll: vi.fn().mockResolvedValue([{ id: 'res-1', tenantId: SYSTEM_TENANT_ID, service: 'nlp', class: 'PINNED' }]) };
    const voiceProfiles = { findAll: vi.fn().mockResolvedValue([{ id: 'vp-1', tenantId: TENANT_A, label: 'Dr A', userId: 'u-9' }]) };
    const reader = new ModelUsageReader(agents as never, fallbacks as never, routing as never, residencyPolicies as never, voiceProfiles as never);
    return { reader, agents, fallbacks, routing, residencyPolicies, voiceProfiles };
  }

  it('the reader reads by id (and the voice profile by SLUG), excluding only soft-deleted rows', async () => {
    const { reader, fallbacks, routing, residencyPolicies, voiceProfiles } = usageReader();
    await reader.referrersOf({ id: 'm-1', slug: 'medical-ner' });
    const notDeleted = { not: ResourceStatusType.DELETED };
    expect(fallbacks.findAll).toHaveBeenCalledWith({ filters: { modelId: 'm-1', resourceStatus: notDeleted } });
    expect(routing.findAll).toHaveBeenCalledWith({ filters: { modelId: 'm-1', resourceStatus: notDeleted } });
    expect(residencyPolicies.findAll).toHaveBeenCalledWith({ filters: { aiModelId: 'm-1', resourceStatus: notDeleted } });
    expect(voiceProfiles.findAll).toHaveBeenCalledWith({ filters: { modelId: 'medical-ner', resourceStatus: notDeleted } });
  });

  it('unregister → 409 MODEL_IN_USE with all six, tenant ids included; nothing written or enqueued', async () => {
    const { reader } = usageReader();
    const residency = { getCatalogue: vi.fn(), unload: vi.fn() };
    const { svc, queue, repo } = build({ usage: reader as never, residency });

    const error = await svc.unregister('m-1', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { code: string; referrers: Array<{ kind: string; tenantId: string; id: string }> };
    expect(body.code).toBe('MODEL_IN_USE');
    expect(body.referrers.map((r) => [r.kind, r.tenantId, r.id])).toEqual(
      expect.arrayContaining([
        ['agent', TENANT_A, 'ag-1'],
        ['agent-fallback', TENANT_B, 'ag-fb'],
        ['agent-asr-submodel', TENANT_B, 'ag-asr'],
        ['routing-policy', SYSTEM_TENANT_ID, 'rp-1'],
        ['residency-policy', SYSTEM_TENANT_ID, 'res-1'],
        ['voice-profile', TENANT_A, 'vp-1'],
      ]),
    );
    expect(body.referrers).toHaveLength(6);
    expect(queue.add).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(residency.unload).not.toHaveBeenCalled();
  });

  it('GET usage returns the same list', async () => {
    const { reader } = usageReader();
    const { svc } = build({ usage: reader as never });
    const usage = await svc.getUsage('m-1');
    expect(usage).toMatchObject({ modelId: 'm-1', slug: 'medical-ner', inUse: true });
    expect(usage.referrers).toHaveLength(6);
  });

  it('an unknown or deleted model is 404', async () => {
    await expect(build({ row: null }).svc.getUsage('x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(build({ row: modelRow({ resourceStatus: ResourceStatusType.DELETED }) }).svc.unregister('m-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ─── R5 ──────────────────────────────────────────────────────────────────────

describe('R5 — unregister unloads first, then marks and enqueues', () => {
  let unloaded: boolean;
  beforeEach(() => {
    unloaded = false;
  });

  it('unloads on every service holding it, then writes UNREGISTERING (OCC) and enqueues one unregister job', async () => {
    const residency = {
      getCatalogue: vi.fn(async () => catalogueWith(unloaded ? [] : [{ service: 'nlp', status: 'loaded' }])),
      unload: vi.fn(async () => {
        unloaded = true;
        return { outcome: 'unloaded' };
      }),
    };
    const { svc, repo, queue, row } = build({ residency });

    const out = await svc.unregister('m-1', { purge: true });

    expect(residency.unload).toHaveBeenCalledWith({
      service: 'nlp',
      modelRef: 'blaze999/Medical-NER',
      force: false,
      reason: 'unregister medical-ner',
    });
    expect(repo.updateWithVersion).toHaveBeenCalledWith('m-1', expect.anything(), 7);
    const unregister = (row!.metaData as Record<string, Record<string, unknown>>).unregister;
    expect(unregister).toMatchObject({ jobId: out.jobId, deleteWeights: true, purge: true, finishedAt: null, error: null, weights: 'deleting' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).toEqual({
      kind: 'unregister',
      jobId: out.jobId,
      aiModelId: 'm-1',
      tenantId: SYSTEM_TENANT_ID,
      userId: 'admin-1',
      deleteWeights: true,
      purge: true,
    });
    expect(out).toEqual({ jobId: out.jobId, weights: 'deleting' });
    // The ORDER is the contract: unload before the row is marked.
    expect(residency.unload.mock.invocationCallOrder[0]).toBeLessThan(repo.updateWithVersion.mock.invocationCallOrder[0]);
  });

  it('still loaded after the unload → 409 MODEL_UNLOAD_FAILED; nothing written or enqueued', async () => {
    const residency = {
      getCatalogue: vi.fn(async () => catalogueWith([{ service: 'nlp', status: 'loaded' }])),
      unload: vi.fn().mockRejectedValue(new ConflictException('IN_FLIGHT')),
    };
    const { svc, repo, queue } = build({ residency });
    const error = await svc.unregister('m-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'MODEL_UNLOAD_FAILED',
      services: [expect.objectContaining({ service: 'nlp' })],
    });
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a model held by stt-worker (not controllable) cannot be unloaded → 409', async () => {
    const residency = { getCatalogue: vi.fn(async () => catalogueWith([{ service: 'stt-worker', status: 'loaded' }])), unload: vi.fn() };
    const { svc } = build({ residency, row: modelRow({ servedBy: 'stt' }) });
    await expect(svc.unregister('m-1')).rejects.toBeInstanceOf(ConflictException);
    expect(residency.unload).not.toHaveBeenCalled();
  });

  it('a prefix another live row shares is kept (kept-shared); deleteWeights:false is kept', async () => {
    const residency = { getCatalogue: vi.fn(async () => catalogueWith([])), unload: vi.fn() };
    const shared = build({ residency, sharing: [modelRow({ id: 'm-2' })] });
    await expect(shared.svc.unregister('m-1')).resolves.toMatchObject({ weights: 'kept-shared' });

    const kept = build({ residency });
    await expect(kept.svc.unregister('m-1', { deleteWeights: false })).resolves.toMatchObject({ weights: 'kept' });
    expect(kept.queue.add.mock.calls[0][1]).toMatchObject({ deleteWeights: false, purge: false });
  });

  it('a model already UNREGISTERING → 409', async () => {
    const row = modelRow({
      // TASK-1023 OD-6: a FRESH open unregister — a stale one may be retried.
      metaData: { unregister: { jobId: 'u0', startedAt: new Date().toISOString(), finishedAt: null, error: null, weights: 'deleting' } },
    });
    const { svc, queue } = build({ row, residency: { getCatalogue: vi.fn(), unload: vi.fn() } });
    const error = await svc.unregister('m-1').catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'MODEL_UNREGISTERING' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a cloud row skips the residency plane entirely', async () => {
    const residency = { getCatalogue: vi.fn(), unload: vi.fn() };
    const { svc, queue } = build({ residency, row: modelRow({ deploymentKind: AiDeploymentKind.CLOUD, bucketPrefix: null }) });
    await expect(svc.unregister('m-1')).resolves.toMatchObject({ weights: 'kept' });
    expect(residency.getCatalogue).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

// ─── R7 ──────────────────────────────────────────────────────────────────────

describe('R7 — download-missing', () => {
  const NOT_ON_DISK = { in: [AiModelAvailability.MISSING, AiModelAvailability.UNKNOWN, AiModelAvailability.PARTIAL] };

  it('asks only for SYSTEM SELF_HOSTED not-on-disk rows; enqueues the fetchable ones; skips DOWNLOADING and unfetchable', async () => {
    const running = new Date().toISOString();
    const rows = [
      modelRow({ id: 'hf-1', slug: 'a', availability: AiModelAvailability.MISSING }),
      modelRow({ id: 's3-1', slug: 'b', source: AiModelSource.S3, sourceUri: 's3://hope-models-src/b/', availability: AiModelAvailability.MISSING }),
      modelRow({ id: 'loc-1', slug: 'c', source: AiModelSource.LOCAL, sourceUri: 'file:///models/c', availability: AiModelAvailability.MISSING }),
      modelRow({
        id: 'dl-1',
        slug: 'd',
        availability: AiModelAvailability.MISSING,
        metaData: { download: { jobId: 'j', startedAt: running, finishedAt: null, error: null, heartbeatAt: running } },
      }),
    ];
    const { svc, repo, queue } = build({ rows });

    const out = await svc.downloadMissing();

    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          tenantId: SYSTEM_TENANT_ID,
          deploymentKind: AiDeploymentKind.SELF_HOSTED,
          availability: NOT_ON_DISK,
          resourceStatus: { not: ResourceStatusType.DELETED },
        },
      }),
    );
    expect(out.enqueued.map((e) => e.id)).toEqual(['hf-1', 's3-1']);
    expect(out.skipped).toEqual([
      { id: 'loc-1', slug: 'c', reason: 'SOURCE_NOT_FETCHABLE' },
      { id: 'dl-1', slug: 'd', reason: 'DOWNLOADING' },
    ]);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls.map((c) => c[1].kind)).toEqual(['download', 'download']);
  });

  // TASK-1023: register-from-path gives a LOCAL row an `s3://hope-models/…` sourceUri. Its weights
  // are already in the bucket, so it must never be queued (the fetcher refuses LOCAL).
  it('a LOCAL row with an s3:// source is skipped as SOURCE_NOT_FETCHABLE, never enqueued', async () => {
    const rows = [modelRow({ id: 'loc-s3', slug: 'l', source: AiModelSource.LOCAL, sourceUri: 's3://hope-models/l/v1/', availability: AiModelAvailability.UNKNOWN })];
    const { svc, queue } = build({ rows });

    const out = await svc.downloadMissing();

    expect(out.enqueued).toEqual([]);
    expect(out.skipped).toEqual([{ id: 'loc-s3', slug: 'l', reason: 'SOURCE_NOT_FETCHABLE' }]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  // Final review I6: a freshly registered row defaults to UNKNOWN and the cluster
  // inventory cannot write MISSING, so a MISSING-only query enqueued nothing.
  it('a never-measured (UNKNOWN) or half-fetched (PARTIAL) row is downloaded; an UNREGISTERING one is skipped', async () => {
    const rows = [
      modelRow({ id: 'unk-1', slug: 'u', availability: AiModelAvailability.UNKNOWN }),
      modelRow({ id: 'par-1', slug: 'p', availability: AiModelAvailability.PARTIAL }),
      modelRow({
        id: 'unr-1',
        slug: 'r',
        availability: AiModelAvailability.UNKNOWN,
        metaData: { unregister: { jobId: 'j', startedAt: new Date().toISOString(), finishedAt: null, error: null } },
      }),
    ];
    const { svc, repo, queue } = build({ rows });

    const out = await svc.downloadMissing();

    expect(repo.findAll.mock.calls[0][0].filters.availability).toEqual(NOT_ON_DISK);
    expect(out.enqueued.map((e) => e.id)).toEqual(['unk-1', 'par-1']);
    expect(out.skipped).toEqual([{ id: 'unr-1', slug: 'r', reason: 'UNREGISTERING' }]);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  // Final review I10a: nothing heartbeats during a BullMQ retry backoff, so a
  // stale window shorter than that wait would re-enqueue a duplicate download.
  it('a row inside a retry backoff (heartbeat older than staleAfterSeconds, younger than the effective window) is skipped as DOWNLOADING', async () => {
    const lastBeat = new Date(Date.now() - 150_000).toISOString();
    const rows = [
      modelRow({
        id: 'bo-1',
        slug: 'b',
        availability: AiModelAvailability.MISSING,
        metaData: { download: { jobId: 'j', startedAt: lastBeat, finishedAt: null, error: null, heartbeatAt: lastBeat } },
      }),
    ];
    const { svc, queue } = build({ rows, settings: { 'modelRegistry.download.staleAfterSeconds': 60, 'modelRegistry.download.maxAttempts': 3 } });

    const out = await svc.downloadMissing();

    expect(out.skipped).toEqual([{ id: 'bo-1', slug: 'b', reason: 'DOWNLOADING' }]);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('unregister refuses DOWNLOAD_IN_PROGRESS for a row inside a retry backoff', async () => {
    const lastBeat = new Date(Date.now() - 150_000).toISOString();
    const row = modelRow({ metaData: { download: { jobId: 'j', startedAt: lastBeat, finishedAt: null, error: null, heartbeatAt: lastBeat } } });
    const { svc, queue } = build({ row, settings: { 'modelRegistry.download.staleAfterSeconds': 60, 'modelRegistry.download.maxAttempts': 3 } });

    await expect(svc.unregister('m-1')).rejects.toMatchObject({ response: { code: 'DOWNLOAD_IN_PROGRESS' } });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
