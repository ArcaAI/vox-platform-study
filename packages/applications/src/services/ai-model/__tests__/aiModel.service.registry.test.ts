/**
 * AiModelService — TASK-860 registry semantics.
 *
 *   - every write is platform-admin only (403, a privilege boundary — not 404)
 *   - every write lands in the SYSTEM tenant through the UNSCOPED base-client
 *     lane, whatever working tenant the caller has elevated into CLS
 *   - `localPath` is DERIVED from `bucketPrefix` (+ `primaryObject`), never typed
 *   - the platform-default election clears the previous holder of each task
 *   - the DTOs do not accept `localPath` (the global pipe rejects it)
 *
 * Boundaries mocked: repository, base client, event emitter, CLS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import { AiDeploymentKind, AiModelAvailability, AiModelFormat, AiModelSource, AiTaskKind, ModelCategory, ModelTaskType, ModelType, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import { CreateModelRequest, UpdateModelRequest } from '../dto';
import { deriveLocalPath } from '../constants';

const BASE_CLIENT = { __lane: 'base' };

function makeCls(opts: { roles?: string[]; tenantId?: string | null } = {}) {
  const roles = opts.roles ?? ['SUPER_ADMIN'];
  const tenantId = opts.tenantId === undefined ? 'tenant-working' : opts.tenantId;
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'user-1', roles };
      if (key === 'tenantId') return tenantId;
      return null;
    }),
    set: vi.fn(),
  };
}

function makeRow(over: Record<string, unknown> = {}) {
  const changes: Record<string, unknown> = {};
  const state: Record<string, unknown> = {
    id: 'row-1',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Medical NER',
    slug: 'medical-ner',
    description: null,
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'blaze999/Medical-NER',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'transformers',
    servedBy: 'nlp',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: null,
    license: null,
    gated: false,
    baseModel: null,
    languages: [],
    hfRevision: null,
    bucketPrefix: null,
    primaryObject: null,
    manifestDigest: null,
    availability: AiModelAvailability.UNKNOWN,
    availabilityCheckedAt: null,
    availabilityDetail: null,
    isPlatformDefaultFor: [],
    provider: 'built-in',
    architecture: null,
    memorySizeMb: 1024,
    computeType: 'float32',
    downloadStatus: 'NOT_DOWNLOADED',
    localPath: null,
    downloadedAt: null,
    fileSizeMb: null,
    checksum: null,
    resourceStatus: ResourceStatusType.ENABLED,
    version: 3,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    metaData: null,
    ...over,
  };
  const row = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'changes') return changes;
      if (prop === 'hasChanges') return Object.keys(changes).length > 0;
      if (prop === 'validate') return () => undefined;
      if (prop === 'delete') return () => {
        target.resourceStatus = ResourceStatusType.DELETED;
        changes.resourceStatus = ResourceStatusType.DELETED;
      };
      if (prop === 'setPlatformDefaultFor')
        return (kinds: AiTaskKind[]) => {
          target.isPlatformDefaultFor = [...new Set(kinds)];
          changes.isPlatformDefaultFor = target.isPlatformDefaultFor;
        };
      return target[prop];
    },
    set(target, prop: string, value) {
      target[prop] = value;
      changes[prop] = value;
      return true;
    },
  });
  return row as unknown as Record<string, unknown> & { changes: Record<string, unknown> };
}

const CREATE: CreateModelRequest = {
  name: 'Whisper ML-EN (GGUF)',
  slug: 'arcaai-whisper-large-ml-en-gguf',
  category: ModelCategory.AUDIO,
  taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  modelType: ModelType.QUANTIZED_MODEL,
  source: AiModelSource.HUGGINGFACE,
  sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
  format: AiModelFormat.WHISPER_CPP,
  libraryName: 'whisper.cpp',
  servedBy: 'stt',
  deploymentKind: AiDeploymentKind.SELF_HOSTED,
};

function makeService(cls = makeCls()) {
  const repo = {
    findById: vi.fn(),
    findBySlug: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findEnabledModels: vi.fn().mockResolvedValue([]),
    findByTaskType: vi.fn().mockResolvedValue([]),
    findByTaskTypeSharedRead: vi.fn().mockResolvedValue([]),
    findPlatformDefaultsFor: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (entity: unknown) => entity),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const emitter = { emit: vi.fn() };
  const db = { baseClient: BASE_CLIENT };
  const service = new AiModelService(repo as never, db as never, emitter as never, cls as never);
  return { service, repo, emitter };
}

describe('AiModelService — platform-admin only (403)', () => {
  it.each([
    ['create', (s: AiModelService) => s.create(CREATE)],
    ['update', (s: AiModelService) => s.update('row-1', { expectedVersion: 3 } as UpdateModelRequest)],
    ['setPlatformDefaultFor', (s: AiModelService) => s.setPlatformDefaultFor('row-1', { tasks: [AiTaskKind.SPEECH_TO_TEXT] })],
    ['delete', (s: AiModelService) => s.delete('row-1')],
    // TASK-932 OD-4 — the four ADMIN READS. They were safe only because
    // `ai-model-admin.controller.ts` carries `manage:all`, which is one
    // decorator away from being the whole boundary; the model registry is
    // platform-admin-owned (TASK-860 §3.1), so the service says so itself.
    ['getById (admin read)', (s: AiModelService) => s.getById('row-1')],
    ['getBySlug (admin read)', (s: AiModelService) => s.getBySlug('medical-ner')],
    ['getAllForAdmin', (s: AiModelService) => s.getAllForAdmin()],
    ['list (admin read)', (s: AiModelService) => s.list({ page: 1, limit: 20 })],
  ])('%s throws ForbiddenException for a tenant admin, before touching the repository', async (_name, call) => {
    const { service, repo } = makeService(makeCls({ roles: ['TENANT_ADMIN'] }));
    await expect(call(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo.findBySlug).not.toHaveBeenCalled();
    expect(repo.findAll).not.toHaveBeenCalled();
  });

  /**
   * TASK-932 OD-4 — the line the assertion above must NOT cross.
   *
   * `getCatalogue` is the TENANT-facing projection behind
   * `ai-model-catalogue.controller.ts`: it is how a tenant admin discovers which
   * models it may select, and it already does its own tier work (SYSTEM rows
   * bounded by the plan, the tenant's OWN BYO rows unbounded). Locking it to the
   * platform admin would take the model picker away from every tenant, which is
   * the opposite of what OD-4 asks for. Reads that project the ADMIN's registry
   * are gated; the read that projects the tenant's own choices is not.
   */
  it('the tenant CATALOGUE stays open; the admin reads require the platform admin', async () => {
    const { service, repo } = makeService(makeCls({ roles: ['TENANT_ADMIN'], tenantId: 'tenant-a' }));

    const catalogue = await service.getCatalogue();
    expect(catalogue).toBeDefined();
    expect(repo.findAll).toHaveBeenCalled();

    // ...and the same caller cannot reach the admin projection of the same rows.
    await expect(service.getAllForAdmin()).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AiModelService — SYSTEM pin through the base-client lane', () => {
  it('create lands the row in the SYSTEM tenant via the base client even when a working tenant is elevated', async () => {
    const { service, repo } = makeService(makeCls({ tenantId: 'tenant-working' }));

    const result = await service.create(CREATE);

    expect(result.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(repo.findBySlug).toHaveBeenCalledWith(SYSTEM_TENANT_ID, CREATE.slug, BASE_CLIENT);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0]![1]).toBe(BASE_CLIENT);
    expect(result.libraryName).toBe('whisper.cpp');
    expect(result.servedBy).toBe('stt');
    expect(result.pipelineTag).toBe('automatic-speech-recognition');
    expect(result.availability).toBe(AiModelAvailability.UNKNOWN);
  });

  it('create refuses a duplicate SYSTEM slug (400) and a CLOUD row without a wireModelId (400)', async () => {
    const { service, repo } = makeService();
    repo.findBySlug.mockResolvedValueOnce(makeRow());
    await expect(service.create(CREATE)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ ...CREATE, slug: 'cloud-row', deploymentKind: AiDeploymentKind.CLOUD })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create of a CLOUD row starts NOT_APPLICABLE with its wire id', async () => {
    const { service } = makeService();
    const result = await service.create({ ...CREATE, slug: 'openai-stt', deploymentKind: AiDeploymentKind.CLOUD, wireModelId: 'gpt-transcribe', libraryName: 'openai' });
    expect(result.availability).toBe(AiModelAvailability.NOT_APPLICABLE);
    expect(result.wireModelId).toBe('gpt-transcribe');
  });

  it('update writes through the base-client CAS lane and 404s a row outside SYSTEM', async () => {
    const { service, repo } = makeService();
    repo.findById.mockResolvedValueOnce(makeRow({ tenantId: 'tenant-x' }));
    await expect(service.update('row-1', { name: 'x', expectedVersion: 3 } as UpdateModelRequest)).rejects.toBeInstanceOf(NotFoundException);

    const row = makeRow();
    repo.findById.mockResolvedValueOnce(row);
    await service.update('row-1', { name: 'Medical NER v2', license: 'mit', expectedVersion: 3 } as UpdateModelRequest);
    expect(repo.updateWithVersion).toHaveBeenCalledWith('row-1', row, 3, BASE_CLIENT);
    expect(row.name).toBe('Medical NER v2');
    expect(row.license).toBe('mit');
  });

  it('delete soft-deletes through the base-client lane', async () => {
    const { service, repo } = makeService();
    const row = makeRow();
    repo.findById.mockResolvedValueOnce(row);
    await service.delete('row-1');
    expect(row.resourceStatus).toBe(ResourceStatusType.DELETED);
    expect(repo.update).toHaveBeenCalledWith('row-1', row, BASE_CLIENT);
  });
});

describe('AiModelService — localPath is derived, never stored (TASK-890 §3.11)', () => {
  it('create with a bucketPrefix derives localPath under the models mount', async () => {
    const { service } = makeService();
    const result = await service.create({ ...CREATE, bucketPrefix: 'arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/', primaryObject: 'ggml-model-f16.bin' });
    expect(result.bucketPrefix).toBe('arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/');
    expect(result.localPath).toBe('/mnt/models-bucket/arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/ggml-model-f16.bin');
  });

  it('update stores the bucket IDENTITY only — the path follows from it, and clearing the prefix clears the path', async () => {
    const { service, repo } = makeService();
    const row = makeRow({ localPath: '/stale/path' });
    repo.findById.mockResolvedValue(row);

    const updated = await service.update('row-1', { bucketPrefix: 'medical-ner/abc/', expectedVersion: 3 } as UpdateModelRequest);
    expect(row.bucketPrefix).toBe('medical-ner/abc/');
    // The RESPONSE carries the derived path; the row's own stale column is never
    // written any more, and L2 drops it.
    expect(updated.localPath).toBe('/mnt/models-bucket/medical-ner/abc/');
    expect(row.localPath).toBe('/stale/path');

    const cleared = await service.update('row-1', { bucketPrefix: '', expectedVersion: 4 } as UpdateModelRequest);
    expect(row.bucketPrefix).toBeNull();
    expect(cleared.localPath).toBeNull();
  });

  it('the response derives localPath from bucketPrefix (+ primaryObject for a single-file loader), never the stored column', async () => {
    const { service, repo } = makeService();
    repo.findById.mockResolvedValueOnce(
      makeRow({ bucketPrefix: 'minicheck-flan-t5-large/q6-k-abc/', primaryObject: 'minicheck.gguf', libraryName: 'llama.cpp', localPath: '/stale' }),
    );
    const result = await service.getById('row-1');
    expect(result?.localPath).toBe(deriveLocalPath('minicheck-flan-t5-large/q6-k-abc/', 'minicheck.gguf'));
  });

  it('the create/update DTOs declare no `localPath` (the global whitelist pipe rejects it)', () => {
    const declared = (target: object) =>
      getMetadataStorage()
        .getTargetValidationMetadatas(target as never, '', false, false)
        .map((m) => m.propertyName);
    expect(declared(CreateModelRequest)).not.toContain('localPath');
    expect(declared(UpdateModelRequest)).not.toContain('localPath');
    expect(declared(CreateModelRequest)).toEqual(expect.arrayContaining(['libraryName', 'servedBy', 'deploymentKind', 'bucketPrefix']));
  });
});

describe('AiModelService — platform-default election', () => {
  it('elects the target and clears each task from its previous holder, both through the base-client lane', async () => {
    const { service, repo, emitter } = makeService();
    const target = makeRow({ id: 'target', slug: 'new-default', version: 5 });
    const holder = makeRow({ id: 'holder', slug: 'old-default', version: 9, isPlatformDefaultFor: [AiTaskKind.SPEECH_TO_TEXT, AiTaskKind.TEXT_TO_SPEECH] });
    repo.findById.mockResolvedValueOnce(target);
    repo.findPlatformDefaultsFor.mockResolvedValueOnce([holder]);

    const result = await service.setPlatformDefaultFor('target', { tasks: [AiTaskKind.SPEECH_TO_TEXT] });

    expect(repo.findPlatformDefaultsFor).toHaveBeenCalledWith(SYSTEM_TENANT_ID, AiTaskKind.SPEECH_TO_TEXT, BASE_CLIENT);
    expect(holder.isPlatformDefaultFor).toEqual([AiTaskKind.TEXT_TO_SPEECH]);
    expect(repo.updateWithVersion).toHaveBeenCalledWith('holder', holder, 9, BASE_CLIENT);
    expect(repo.updateWithVersion).toHaveBeenCalledWith('target', target, 5, BASE_CLIENT);
    expect(result.isPlatformDefaultFor).toEqual([AiTaskKind.SPEECH_TO_TEXT]);
    // One sys-event per cleared holder + one for the election.
    expect(emitter.emit).toHaveBeenCalledTimes(2);
  });

  it('refuses to elect a DISABLED row and lets an empty list withdraw a row', async () => {
    const { service, repo } = makeService();
    repo.findById.mockResolvedValueOnce(makeRow({ resourceStatus: ResourceStatusType.DISABLED }));
    await expect(service.setPlatformDefaultFor('row-1', { tasks: [AiTaskKind.TEXT_GENERATION] })).rejects.toBeInstanceOf(BadRequestException);

    const row = makeRow({ isPlatformDefaultFor: [AiTaskKind.TEXT_GENERATION] });
    repo.findById.mockResolvedValueOnce(row);
    const result = await service.setPlatformDefaultFor('row-1', { tasks: [] });
    expect(result.isPlatformDefaultFor).toEqual([]);
    expect(repo.findPlatformDefaultsFor).not.toHaveBeenCalled();
  });
});
