/**
 * TASK-958 D-5 — the picker entry is per CONNECTION, not per vendor.
 *
 * A tenant holding two OpenAI accounts sees two entries whose `id` is
 * `byo:<service>:<connectionSlug>`; the connection fields are the only thing that
 * tells them apart, and each model sits under the connection it was DECLARED on
 * (`AiModel.sourceConnectionId`). The DEFAULT connection keeps `slug === provider`,
 * so its id, its label and every model slug under it are unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiModelService } from '../aiModel.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_ID = 'tenant-1';
const CONN_DEFAULT = 'conn-openai-default';
const CONN_RESEARCH = 'conn-openai-research';

function row(init: { id: string; slug: string; provider: string | null; tenantId: string; sourceConnectionId?: string | null }) {
  return {
    id: init.id,
    slug: init.slug,
    name: init.slug.toUpperCase(),
    description: null,
    tenantId: init.tenantId,
    provider: init.provider,
    taskType: 'TEXT_GENERATION',
    deploymentKind: 'CLOUD',
    availability: 'NOT_APPLICABLE',
    isPlatformDefaultFor: [],
    resourceStatus: 'ENABLED',
    tags: [],
    metaData: null,
    bucketPrefix: null,
    primaryObject: null,
    sourceUri: 'https://api.openai.com',
    sourceRevision: null,
    wireModelId: 'gpt-5.4-mini',
    checksum: null,
    createdBy: 'someone',
    updatedBy: 'someone',
    version: 1,
    format: 'API',
    libraryName: 'openai',
    servedBy: 'text',
    sourceConnectionId: init.sourceConnectionId ?? null,
  };
}

const DEFAULT_MODEL = row({ id: 'm1', slug: 'openai-gpt-5-4-mini', provider: 'openai', tenantId: TENANT_ID, sourceConnectionId: CONN_DEFAULT });
const SIBLING_MODEL = row({
  id: 'm2',
  slug: 'openai-research-gpt-5-4-mini',
  provider: 'openai',
  tenantId: TENANT_ID,
  sourceConnectionId: CONN_RESEARCH,
});

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockDatabaseService = { baseClient: { __lane: 'base' } };
const mockModelRepository = { findAll: vi.fn(), findById: vi.fn(), findBySlug: vi.fn(), count: vi.fn() };
const mockConnections = { list: vi.fn(), findRow: vi.fn(), findDefaultRow: vi.fn(), resolveConnection: vi.fn() };
const mockTenantRepository = { findById: vi.fn() };

const build = (): AiModelService =>
  new (AiModelService as unknown as new (...args: unknown[]) => AiModelService)(
    mockModelRepository,
    mockDatabaseService,
    mockEventEmitter,
    mockClsService,
    mockConnections,
    mockTenantRepository,
  );

const CONNECTION_ROWS = [
  { id: CONN_DEFAULT, tenantId: TENANT_ID, service: 'llm', provider: 'openai', slug: 'openai', name: null, isDefault: true, enabled: true, hasKey: true },
  {
    id: CONN_RESEARCH,
    tenantId: TENANT_ID,
    service: 'llm',
    provider: 'openai',
    slug: 'openai-research',
    name: 'Research account',
    isDefault: false,
    enabled: true,
    hasKey: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT_ID : key === 'user' ? { id: 'u-1', roles: ['TENANT_ADMIN'] } : null));
  mockModelRepository.findAll.mockResolvedValue([DEFAULT_MODEL, SIBLING_MODEL]);
  mockTenantRepository.findById.mockResolvedValue({ id: TENANT_ID, plan: 'ENTERPRISE' });
  mockConnections.list.mockImplementation(async (service: string) => (service === 'llm' ? CONNECTION_ROWS : []));
  mockConnections.findDefaultRow.mockImplementation(async (service: string, provider: string, tenantId: string) =>
    tenantId === TENANT_ID && service === 'llm' && provider === 'openai'
      ? { id: CONN_DEFAULT, tenantId: TENANT_ID, service, provider, enabled: true, encryptedApiKey: new Uint8Array([1]) }
      : null,
  );
  mockConnections.findRow.mockResolvedValue(null);
  mockConnections.resolveConnection.mockImplementation(async (service: string, provider: string) =>
    service === 'llm' && provider === 'openai' ? { service, provider, encryptedApiKey: new Uint8Array([1]), source: 'tenant' } : null,
  );
});

describe('TASK-958 (18) — one catalogue provider entry per CONNECTION', () => {
  it('two OpenAI connections produce two `byo:llm:*` entries carrying slug, name and isDefault', async () => {
    const { providers } = await build().getCatalogue();
    const byo = providers.filter((p) => p.group === 'byo');

    expect(byo.map((p) => p.id)).toEqual(['byo:llm:openai', 'byo:llm:openai-research']);
    expect(byo[0]).toMatchObject({ connectionSlug: 'openai', connectionName: null, isDefault: true, connectionId: CONN_DEFAULT });
    expect(byo[1]).toMatchObject({ connectionSlug: 'openai-research', connectionName: 'Research account', isDefault: false, connectionId: CONN_RESEARCH });
  });

  it("the DEFAULT connection keeps today's id AND today's label (the vendor id), so nothing that works now changes", async () => {
    const { providers } = await build().getCatalogue();
    const def = providers.find((p) => p.id === 'byo:llm:openai');
    expect(def?.name).toBe('openai');
    // The sibling's vendor label is the SAME string — the connection fields carry the
    // difference, which is what the console renders beside it.
    expect(providers.find((p) => p.id === 'byo:llm:openai-research')?.name).toBe('openai');
  });

  it('each model sits under the connection it was DECLARED on', async () => {
    const { models } = await build().getCatalogue();
    expect(models.find((m) => m.slug === 'openai-gpt-5-4-mini')?.providerId).toBe('byo:llm:openai');
    expect(models.find((m) => m.slug === 'openai-research-gpt-5-4-mini')?.providerId).toBe('byo:llm:openai-research');
  });

  it('the `hope` group names no connection at all', async () => {
    const { providers } = await build().getCatalogue();
    const hope = providers.find((p) => p.group === 'hope');
    expect(hope).toMatchObject({ connectionId: null, connectionSlug: null, connectionName: null, isDefault: null });
  });

  it('a model whose connection is DISABLED stays listed and unusable under that connection, not merged into the default', async () => {
    mockConnections.list.mockImplementation(async (service: string) =>
      service === 'llm' ? [CONNECTION_ROWS[0], { ...CONNECTION_ROWS[1], enabled: false }] : [],
    );
    const { providers, models } = await build().getCatalogue();
    expect(models.find((m) => m.slug === 'openai-research-gpt-5-4-mini')?.providerId).toBe('byo:llm:openai-research');
    const sibling = providers.find((p) => p.id === 'byo:llm:openai-research');
    expect(sibling).toMatchObject({ usable: false, reason: 'no-enabled-connection', connectionSlug: 'openai-research' });
  });
});
