/**
 * TASK-890 L1 — `AiModelService.getCatalogue` (§3.7).
 *
 * The tenant-facing READ of the model registry: two groups (the tenant's own BYO
 * connections first, then the single "Hope provider"), a `usable` verdict per
 * provider CLASS, plan-tier bounding, and a projection that carries NOTHING
 * about storage or operator identity.
 *
 * Boundaries mocked: the repository (I/O), the connection port (I/O + Vault),
 * the tenant repository (I/O), CLS and the event emitter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiModelService } from '../aiModel.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_ID = 'tenant-1';

const AiDeploymentKind = { SELF_HOSTED: 'SELF_HOSTED', CLOUD: 'CLOUD' } as const;
const AiModelAvailability = {
  UNKNOWN: 'UNKNOWN',
  AVAILABLE: 'AVAILABLE',
  MISSING: 'MISSING',
  PARTIAL: 'PARTIAL',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
const ModelTaskType = { TEXT_GENERATION: 'TEXT_GENERATION', AUTOMATIC_SPEECH_RECOGNITION: 'AUTOMATIC_SPEECH_RECOGNITION' } as const;
const ResourceStatusType = { ENABLED: 'ENABLED' } as const;
const TenantPlan = { STARTER: 'STARTER', ENTERPRISE: 'ENTERPRISE' } as const;

interface RowInit {
  id: string;
  slug: string;
  tenantId: string;
  provider: string | null;
  taskType?: string;
  deploymentKind?: string;
  availability?: string;
  tags?: string[];
  bucketPrefix?: string | null;
}

/** A catalogue row as the repository hands it back (only the fields the catalogue reads). */
function row(init: RowInit) {
  return {
    id: init.id,
    slug: init.slug,
    name: init.slug.toUpperCase(),
    description: null,
    tenantId: init.tenantId,
    provider: init.provider,
    taskType: init.taskType ?? ModelTaskType.TEXT_GENERATION,
    deploymentKind: init.deploymentKind ?? AiDeploymentKind.SELF_HOSTED,
    availability: init.availability ?? AiModelAvailability.NOT_APPLICABLE,
    isPlatformDefaultFor: [],
    resourceStatus: ResourceStatusType.ENABLED,
    tags: init.tags ?? [],
    metaData: null,
    // Storage / operator identity — none of this may cross into the projection.
    bucketPrefix: init.bucketPrefix ?? 'models/x/1',
    primaryObject: null,
    sourceUri: 'hf:acme/x',
    sourceRevision: null,
    wireModelId: 'x',
    checksum: 'sha256-x',
    createdBy: 'someone',
    updatedBy: 'someone',
    version: 3,
    format: 'GGUF',
    libraryName: 'llama.cpp',
    servedBy: 'text',
  };
}

const ENGINE_ROW = row({ id: 'm-engine', slug: 'gemma-3-lmstudio', tenantId: SYSTEM_TENANT_ID, provider: 'lm-studio' });
const CLOUD_ROW = row({
  id: 'm-cloud',
  slug: 'azure-gpt-5-mini',
  tenantId: SYSTEM_TENANT_ID,
  provider: 'azure',
  deploymentKind: AiDeploymentKind.CLOUD,
});
const SELF_HOST_ROW = row({
  id: 'm-self',
  slug: 'whisper-large-v3',
  tenantId: SYSTEM_TENANT_ID,
  provider: 'built-in',
  taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  availability: AiModelAvailability.MISSING,
});
const TIER_ROW = row({ id: 'm-tier', slug: 'big-llm', tenantId: SYSTEM_TENANT_ID, provider: 'lm-studio', tags: ['tier:full'] });
const UNASSIGNED_ROW = row({ id: 'm-none', slug: 'orphan-model', tenantId: SYSTEM_TENANT_ID, provider: null });
const BYO_ROW = row({ id: 'm-byo', slug: 'azure-my-deployment', tenantId: TENANT_ID, provider: 'azure', deploymentKind: AiDeploymentKind.CLOUD });

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockDatabaseService = { baseClient: { __lane: 'base' } };

const mockModelRepository = { findAll: vi.fn(), findById: vi.fn(), findBySlug: vi.fn(), count: vi.fn() };

const mockConnections = {
  list: vi.fn(),
  findRow: vi.fn(),
  resolveConnection: vi.fn(),
};

const mockTenantRepository = { findById: vi.fn() };

function build(): AiModelService {
  return new (AiModelService as unknown as new (...args: unknown[]) => AiModelService)(
    mockModelRepository,
    mockDatabaseService,
    mockEventEmitter,
    mockClsService,
    mockConnections,
    mockTenantRepository,
  );
}

function asTenantAdmin(): void {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'u-1', roles: ['TENANT_ADMIN'] };
      case 'tenantId':
        return TENANT_ID;
      default:
        return null;
    }
  });
}

describe('TASK-890 AiModelService.getCatalogue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asTenantAdmin();
    // The repository does the `taskType` / `resourceStatus` narrowing; the mock
    // honours the filter it is handed so the service's own filtering is what is
    // under test, not a stub that ignores it.
    mockModelRepository.findAll.mockImplementation(async ({ filters }: { filters: { taskType?: string } }) =>
      [ENGINE_ROW, CLOUD_ROW, SELF_HOST_ROW, TIER_ROW, UNASSIGNED_ROW, BYO_ROW].filter((r) => !filters.taskType || r.taskType === filters.taskType),
    );
    mockTenantRepository.findById.mockResolvedValue({ id: TENANT_ID, plan: TenantPlan.ENTERPRISE });
    // One ENABLED, keyed tenant `llm:azure` connection.
    mockConnections.list.mockImplementation(async (service: string) =>
      service === 'llm' ? [{ tenantId: TENANT_ID, service: 'llm', provider: 'azure', enabled: true, hasKey: true }] : [],
    );
    mockConnections.findRow.mockImplementation(async (service: string, provider: string, tenantId: string) => {
      if (tenantId === TENANT_ID && service === 'llm' && provider === 'azure') {
        return { id: 'conn-1', tenantId: TENANT_ID, service, provider, enabled: true, encryptedApiKey: new Uint8Array([1]) };
      }
      if (tenantId === SYSTEM_TENANT_ID && ENGINE_OR_SELF.has(provider)) {
        return { id: `sys-${provider}`, tenantId: SYSTEM_TENANT_ID, service, provider, enabled: true, encryptedApiKey: null };
      }
      return null;
    });
    mockConnections.resolveConnection.mockImplementation(async (service: string, provider: string) => {
      if (service === 'llm' && provider === 'azure') {
        return { service, provider, encryptedApiKey: new Uint8Array([1]), source: 'tenant' };
      }
      if (ENGINE_OR_SELF.has(provider)) {
        return { service, provider, encryptedApiKey: null, source: 'system' };
      }
      return null;
    });
  });

  const ENGINE_OR_SELF = new Set(['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']);

  it('returns exactly one `hope` provider and one BYO entry per ENABLED tenant connection', async () => {
    const result = await build().getCatalogue();

    const hope = result.providers.filter((p) => p.group === 'hope');
    expect(hope).toHaveLength(1);
    expect(hope[0].id).toBe('hope');
    expect(hope[0].providerClass).toBeNull();

    const byo = result.providers.filter((p) => p.group === 'byo');
    expect(byo.map((p) => p.id)).toEqual(['byo:llm:azure']);
    expect(byo[0].connectionId).toBe('conn-1');
    expect(byo[0].usable).toBe(true);
    // BYO entries come FIRST in picker order (OD-A).
    expect(result.providers[0].group).toBe('byo');
  });

  it('files the tenant-owned row under its BYO provider and every SYSTEM row under `hope`', async () => {
    const result = await build().getCatalogue();

    const byModel = new Map(result.models.map((m) => [m.id, m]));
    expect(byModel.get('m-byo')!.providerId).toBe('byo:llm:azure');
    expect(byModel.get('m-byo')!.providerClass).toBe('cloud-byo');
    expect(byModel.get('m-engine')!.providerId).toBe('hope');
    expect(byModel.get('m-cloud')!.providerId).toBe('hope');
    expect(byModel.get('m-self')!.providerId).toBe('hope');
  });

  it('decides `usable` per provider class', async () => {
    const result = await build().getCatalogue();
    const byModel = new Map(result.models.map((m) => [m.id, m]));

    // engine-served: the SYSTEM engine connection is ENABLED.
    expect(byModel.get('m-engine')!.usable).toBe(true);
    // cloud-byo: the owning connection is enabled AND keyed.
    expect(byModel.get('m-byo')!.usable).toBe(true);
    // platform-self-host: the MEASURED availability is MISSING.
    expect(byModel.get('m-self')!.usable).toBe(false);
    expect(byModel.get('m-self')!.unusableReason).toBe('weights-not-available');
  });

  // `NOT_APPLICABLE` is stamped by the bucket inventory on exactly one kind of
  // self-host row: a library that ships its weights INSIDE the Python package
  // (`pyrnnoise`, `deepfilternet`), i.e. "there is nothing to fetch". The
  // readiness sweep already calls those rows `ready` ("served from the package;
  // no bucket artifact required"), so calling them `weights-not-available` in
  // the same payload contradicted the platform's own verdict.
  it('treats a platform-self-host row whose weights ship in the package (NOT_APPLICABLE) as usable', async () => {
    mockModelRepository.findAll.mockResolvedValue([
      { ...SELF_HOST_ROW, id: 'm-packaged', slug: 'rnnoise', availability: AiModelAvailability.NOT_APPLICABLE },
    ] as never);

    const result = await build().getCatalogue();
    const model = result.models.find((m) => m.id === 'm-packaged')!;

    expect(model.providerClass).toBe('platform-self-host');
    expect(model.usable).toBe(true);
    expect(model.unusableReason).toBeNull();
  });

  it('still refuses a platform-self-host row the inventory has not measured', async () => {
    mockModelRepository.findAll.mockResolvedValue([
      { ...SELF_HOST_ROW, id: 'm-unknown', slug: 'unmeasured', availability: AiModelAvailability.UNKNOWN },
    ] as never);

    const result = await build().getCatalogue();
    const model = result.models.find((m) => m.id === 'm-unknown')!;

    expect(model.usable).toBe(false);
    expect(model.unusableReason).toBe('weights-not-available');
  });

  it('marks a cloud-platform row unusable when the tenant VETOED the provider', async () => {
    mockConnections.list.mockResolvedValue([]);
    mockConnections.findRow.mockImplementation(async (service: string, provider: string, tenantId: string) =>
      tenantId === TENANT_ID && provider === 'azure'
        ? { id: 'conn-1', tenantId: TENANT_ID, service, provider, enabled: false, encryptedApiKey: null }
        : null,
    );
    mockConnections.resolveConnection.mockImplementation(async (service: string, provider: string) =>
      provider === 'azure' ? null : { service, provider, encryptedApiKey: null, source: 'system' },
    );

    const result = await build().getCatalogue();
    const cloud = result.models.find((m) => m.id === 'm-cloud')!;
    expect(cloud.providerClass).toBe('cloud-platform');
    expect(cloud.usable).toBe(false);
    expect(cloud.unusableReason).toBe('no-enabled-connection');
  });

  it('bounds the Hope group by the tenant plan tier — entitlements bound, they never supply', async () => {
    mockTenantRepository.findById.mockResolvedValue({ id: TENANT_ID, plan: TenantPlan.STARTER });

    const result = await build().getCatalogue();
    expect(result.models.map((m) => m.id)).not.toContain('m-tier');
    expect(result.models.map((m) => m.id)).toContain('m-engine');
  });

  it('hides a row naming no servable provider from a tenant, and counts it for a super admin only', async () => {
    const tenantView = await build().getCatalogue();
    expect(tenantView.models.map((m) => m.id)).not.toContain('m-none');
    expect(tenantView.unassignedProviderCount).toBeUndefined();

    mockClsService.get.mockImplementation((key: string) =>
      key === 'user' ? { id: 'u-2', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? TENANT_ID : null,
    );
    const adminView = await build().getCatalogue();
    expect(adminView.models.map((m) => m.id)).not.toContain('m-none');
    expect(adminView.unassignedProviderCount).toBe(1);
  });

  it('stamps readiness `unknown` when no readiness service is wired (wave-1 independence)', async () => {
    const result = await build().getCatalogue();
    for (const model of result.models) {
      expect(model.readiness).toBe('unknown');
      expect(model.readinessCheckedAt).toBeNull();
    }
  });

  it('reads the readiness SNAPSHOT when one is wired, and never probes', async () => {
    const checkedAt = new Date('2026-09-06T10:00:00.000Z');
    const readiness = {
      getSnapshot: vi.fn().mockResolvedValue({ checkedAt, models: { 'm-engine': { readiness: 'loadable', detail: 'listed, not resident' } } }),
    };
    const service = new (AiModelService as unknown as new (...args: unknown[]) => AiModelService)(
      mockModelRepository,
      mockDatabaseService,
      mockEventEmitter,
      mockClsService,
      mockConnections,
      mockTenantRepository,
      readiness,
    );

    const result = await service.getCatalogue();
    const engine = result.models.find((m) => m.id === 'm-engine')!;
    expect(engine.readiness).toBe('loadable');
    expect(engine.readinessDetail).toBe('listed, not resident');
    expect(engine.readinessCheckedAt).toEqual(checkedAt);
    // A model the snapshot does not name is `unknown`, not stale.
    expect(result.models.find((m) => m.id === 'm-cloud')!.readiness).toBe('unknown');
    expect(readiness.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('filters by task type', async () => {
    const result = await build().getCatalogue({ taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION as never });
    expect(result.models.map((m) => m.id)).toEqual(['m-self']);
  });

  it('projects exactly the §3.7 key set — no storage, no operator identity, no tenant id', async () => {
    const result = await build().getCatalogue();
    const keys = Object.keys(result.models[0]).sort();
    expect(keys).toEqual(
      [
        'availability',
        'capabilities',
        'deploymentKind',
        'description',
        'id',
        'isPlatformDefaultFor',
        'name',
        'pipelineTag',
        'provider',
        'providerClass',
        'providerId',
        'readiness',
        'readinessCheckedAt',
        'readinessDetail',
        'resourceStatus',
        'slug',
        'taskType',
        'unusableReason',
        'usable',
      ].sort(),
    );
    for (const forbidden of [
      'bucketPrefix',
      'localPath',
      'checksum',
      'createdBy',
      'updatedBy',
      'tenantId',
      'sourceConnectionId',
      'sourceUri',
      'wireModelId',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is a READ: it never asserts a platform admin and never touches the write lane', async () => {
    await expect(build().getCatalogue()).resolves.toBeDefined();
    expect(mockModelRepository.findAll).toHaveBeenCalledTimes(1);
    // The read goes through the EXTENDED client (no explicit tenant pin — the
    // shared-read widening returns [caller, SYSTEM]).
    const [args] = mockModelRepository.findAll.mock.calls[0];
    expect(args.filters.tenantId).toBeUndefined();
  });
});
