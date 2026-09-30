/**
 * `listRegistry` — the read-only registry view every admin may read (OD-1 / OD-4).
 *
 * SYSTEM rows only, the same paginated query contract as `list()`, each row
 * redacted to descriptive columns + a one-word status derived through the
 * UNGATED status-only residency read. Filters, search fields and sorts may only
 * name visible columns, so a hidden column cannot be probed through the query.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  AiTaskKind,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

const VIEW_KEYS = [
  'availability',
  'deploymentKind',
  'description',
  'format',
  'gated',
  'id',
  'isPlatformDefaultFor',
  'languages',
  'libraryName',
  'license',
  'lifecycleStatus',
  'memorySizeMb',
  'name',
  'resourceStatus',
  'servedBy',
  'slug',
  'taskType',
  'updatedAt',
];

function modelRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Medical NER',
    slug: 'medical-ner',
    description: 'Clinical entity tagger',
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
    provider: 'built-in',
    license: 'apache-2.0',
    gated: false,
    languages: ['en'],
    bucketPrefix: 'hf/blaze999/Medical-NER/',
    primaryObject: null,
    manifestDigest: 'sha256:secret-digest',
    checksum: 'secret-checksum',
    localPath: '/mnt/models-bucket/hf/blaze999/Medical-NER/',
    availability: AiModelAvailability.AVAILABLE,
    availabilityDetail: { objects: 12 },
    isPlatformDefaultFor: [AiTaskKind.NAMED_ENTITY_RECOGNITION],
    memorySizeMb: 1024,
    observedMemoryMb: 900,
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: { download: { error: { code: 'X', message: 'secret error' } } },
    version: 3,
    tags: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    ...over,
  };
}

function build(roles: string[], tenantId: string | null) {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'u-1', roles };
      if (key === 'tenantId') return tenantId;
      return null;
    }),
    set: vi.fn(),
  };
  const repo = {
    findAll: vi.fn().mockResolvedValue([modelRow(), modelRow({ id: 'm-2', slug: 'whisper', observedMemoryMb: null, memorySizeMb: 500, description: null, license: null, gated: null })]),
    count: vi.fn().mockResolvedValue(2),
  };
  const lifecycle = {
    forRows: vi.fn(),
    statusForRows: vi.fn(
      async () =>
        new Map([
          ['m-1', 'SERVING'],
          ['m-2', 'DOWNLOADED'],
        ]),
    ),
  };
  const svc = new AiModelService(
    repo as never,
    { baseClient: {} } as never,
    { emit: vi.fn() } as never,
    cls as never,
    undefined,
    undefined,
    undefined,
    lifecycle as never,
  );
  return { svc, repo, lifecycle };
}

describe('AiModelService.listRegistry — the redacted registry view', () => {
  it('a tenant admin reads SYSTEM rows, each redacted to the view shape, with status from the status-only read', async () => {
    const { svc, repo, lifecycle } = build(['TENANT_ADMIN'], TENANT_A);

    const page = await svc.listRegistry({ page: 1, limit: 20 } as never);

    expect(repo.findAll.mock.calls[0][0].filters).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    expect(repo.count.mock.calls[0][0].filters).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
    expect(lifecycle.statusForRows).toHaveBeenCalledTimes(1);
    expect(lifecycle.forRows).not.toHaveBeenCalled();
    expect(page).toMatchObject({ total: 2, page: 1, limit: 20, totalPages: 1 });

    const [first, second] = page.data;
    expect(first).toMatchObject({ id: 'm-1', lifecycleStatus: 'SERVING', memorySizeMb: 900, updatedAt: '2026-09-02T00:00:00.000Z' });
    expect(second).toMatchObject({ id: 'm-2', lifecycleStatus: 'DOWNLOADED', memorySizeMb: 500, description: null, license: null, gated: null });

    for (const item of page.data) expect(Object.keys(item).sort()).toEqual(VIEW_KEYS);
    const wire = JSON.stringify(page);
    for (const secret of ['secret-digest', 'secret-checksum', 'secret error', 'hf/blaze999', '/mnt/models-bucket', 'blaze999/Medical-NER', 'objects']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('a platform admin may read it too', async () => {
    const { svc } = build(['SUPER_ADMIN'], null);
    await expect(svc.listRegistry({} as never)).resolves.toMatchObject({ total: 2 });
  });

  it('a failed status derivation still returns the rows, reported NOT_OBSERVED', async () => {
    const { svc, lifecycle } = build(['TENANT_ADMIN'], TENANT_A);
    lifecycle.statusForRows.mockRejectedValueOnce(new Error('boom'));
    const page = await svc.listRegistry({} as never);
    expect(page.data.map((m) => m.lifecycleStatus)).toEqual(['NOT_OBSERVED', 'NOT_OBSERVED']);
  });

  it.each([
    ['a filter on a hidden column', { filters: 'metaData[path]:download' }],
    ['a filter on a hidden column inside a group', { filters: 'OR(bucketPrefix[contains]:hf,name[contains]:x)' }],
    ['a search over a hidden column', { search: 'sha', searchFields: 'checksum' }],
    ['a sort on a hidden column', { sort: 'manifestDigest:asc' }],
  ])('refuses %s with a 400', async (_label, query) => {
    const { svc, repo } = build(['TENANT_ADMIN'], TENANT_A);
    await expect(svc.listRegistry(query as never)).rejects.toMatchObject({ status: 400 });
    expect(repo.findAll).not.toHaveBeenCalled();
  });

  it('accepts filters, search and sort on visible columns', async () => {
    const { svc, repo } = build(['TENANT_ADMIN'], TENANT_A);
    await svc.listRegistry({ filters: 'taskType[equals]:TOKEN_CLASSIFICATION', search: 'ner', searchFields: 'name,slug', sort: 'updatedAt:desc' } as never);
    expect(repo.findAll).toHaveBeenCalledTimes(1);
  });
});
