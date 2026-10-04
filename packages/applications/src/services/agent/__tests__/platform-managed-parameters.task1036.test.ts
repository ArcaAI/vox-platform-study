/**
 * TASK-1036 W2 / OD-11 — the platform-managed guard, generalised.
 *
 * > Simple, friendly configuration. No advanced or encoder/decoder hyperparameters. Temperature and
 * > max output tokens only, when the provider and model support them. (W2)
 *
 * TASK-991 locked ONE path (`readOnly`). The contract now marks every parameter leaf outside
 * `TENANT_EDITABLE_PARAMETER_PATHS` with `x-platformManaged` and exposes the union as
 * `platformManagedPaths(task)`. This file pins the generalised write path:
 *
 *  - WHICH paths: the contract's `platformManagedPaths(task)`, nothing restated here.
 *  - WHO: a non-super-admin writing (create / update / import) any of them → 403
 *    `AGENT_PARAMETER_PLATFORM_MANAGED`. A SUPER_ADMIN may write them in ANY tenant (OD-11 — the old
 *    SYSTEM-only exemption is gone).
 *  - EXISTING VALUES: left untouched. A tenant PATCH that sends them back unchanged passes; one that
 *    OMITS them (the console hides those fields) carries the stored value forward rather than
 *    dropping it — nothing is silently lost, and nothing is refused that the tenant never touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { PORTABLE_BUNDLE_SCHEMA_VERSION, platformManagedPaths } from '@arcaai/workflow-contract';
import { AgentService } from '../agent.service';
import { platformManagedParameterPaths } from '../platform-managed-parameters';

const TENANT = '50000000-0000-0000-0000-000000000000';

const clsStore: Record<string, unknown> = {};
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = {
  findByIdVisible: vi.fn(),
  findMaxVersionNumber: vi.fn(async () => 0),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (e: unknown) => e), deleteAllForAgent: vi.fn() };
const TEXT_MODEL = {
  id: 'model-text',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'gpt-x',
  taskType: 'TEXT_GENERATION',
  provider: 'openai',
  availability: 'NOT_APPLICABLE',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: { capabilities: { supportedGenerationParams: ['temperature', 'maxTokens', 'topP'] } },
};
const mockAiModelRepository = {
  findById: vi.fn(async () => TEXT_MODEL),
  findBySlug: vi.fn(async () => TEXT_MODEL),
  findByTaskTypeSharedRead: vi.fn(async () => []),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

function textAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-note',
    name: 'Clinic note',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-text',
    instruction: { systemPrompt: 'Write the note.' },
    parameters: { generation: { temperature: 0.2, topP: 0.9, seed: 7 } },
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    hasChanges: true,
    validate: vi.fn(),
    ...overrides,
  } as never;
}

function makeService() {
  return new AgentService(
    mockAgentRepository as never,
    mockFallbackRepository as never,
    mockAiModelRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined as never,
    undefined as never,
    { findById: vi.fn(), findByName: vi.fn() } as never,
    { findByVersionNumber: vi.fn() } as never,
  );
}

function persistedUpdate(): Record<string, unknown> {
  const call = mockAgentRepository.updateWithVersion.mock.calls[0] as unknown as [string, { parameters: Record<string, unknown> }, number];
  return call[1].parameters;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: ['TENANT_ADMIN'] };
  mockAgentRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAgentRepository.create.mockImplementation(async (entity: unknown) => entity);
  mockAgentRepository.findMaxVersionNumber.mockImplementation(async () => 0);
  mockAiModelRepository.findById.mockImplementation(async () => TEXT_MODEL);
  mockAiModelRepository.findBySlug.mockImplementation(async () => TEXT_MODEL);
  mockFallbackRepository.findByAgentId.mockImplementation(async () => []);
  mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
});

describe('which paths are platform-managed — the contract decides', () => {
  it('delegates to `platformManagedPaths` for every task', () => {
    for (const task of Object.values(AgentTask)) {
      expect(platformManagedParameterPaths(task)).toEqual(platformManagedPaths(task));
    }
  });

  it('keeps TASK-991’s embedding lock and adds the W2 tuning knobs', () => {
    expect(platformManagedParameterPaths(AgentTask.SPEECH_TO_TEXT)).toContain('audioFrontEnd.diarization.embeddingModelSlug');
    expect(platformManagedParameterPaths(AgentTask.SPEECH_TO_TEXT)).toContain('decoding.beamSize');
    expect(platformManagedParameterPaths(AgentTask.TEXT_GENERATION)).toEqual(expect.arrayContaining(['generation.topP', 'generation.seed']));
    expect(platformManagedParameterPaths(AgentTask.TEXT_GENERATION)).not.toContain('generation.temperature');
    expect(platformManagedParameterPaths(AgentTask.TEXT_GENERATION)).not.toContain('generation.maxTokens');
  });
});

describe('update — a tenant admin', () => {
  it('REFUSES a change to a platform-managed path (403, named), and writes nothing', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent());
    await expect(
      makeService().update('agent-1', { parameters: { generation: { temperature: 0.2, topP: 0.5, seed: 7 } } }),
    ).rejects.toMatchObject({ response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED', paths: ['generation.topP'] } });
    expect(mockAgentRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('PASSES a tenant-editable edit that sends the platform-managed values back unchanged', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent());
    await makeService().update('agent-1', { parameters: { generation: { temperature: 0.7, topP: 0.9, seed: 7 } } });
    expect(persistedUpdate()).toEqual({ generation: { temperature: 0.7, topP: 0.9, seed: 7 } });
  });

  it('PASSES a tenant-editable edit that OMITS them — the stored values are carried forward, untouched', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent());
    await makeService().update('agent-1', { parameters: { generation: { temperature: 0.7, maxTokens: 800 } } });
    expect(persistedUpdate()).toEqual({ generation: { temperature: 0.7, maxTokens: 800, topP: 0.9, seed: 7 } });
  });

  it('REFUSES an explicit null over a stored platform-managed value — that is a change, not an omission', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent());
    await expect(
      makeService().update('agent-1', { parameters: { generation: { temperature: 0.2, topP: null, seed: 7 } } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('update — a super admin may write them in ANY tenant (OD-11)', () => {
  it('inside a CUSTOMER tenant', async () => {
    clsStore.user = { id: 'user-platform', roles: ['SUPER_ADMIN'] };
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent());
    await makeService().update('agent-1', { parameters: { generation: { temperature: 0.2, topP: 0.5 } } });
    // A super admin's write is taken as written — no carry-forward: removing `seed` is theirs to do.
    expect(persistedUpdate()).toEqual({ generation: { temperature: 0.2, topP: 0.5 } });
  });

  it('on the SYSTEM tier', async () => {
    clsStore.tenantId = SYSTEM_TENANT_ID;
    clsStore.user = { id: 'user-platform', roles: ['SUPER_ADMIN'] };
    mockAgentRepository.findByIdVisible.mockResolvedValue(textAgent({ tenantId: SYSTEM_TENANT_ID }));
    await makeService().update('agent-1', { parameters: { generation: { topP: 0.4 } } });
    expect(persistedUpdate()).toEqual({ generation: { topP: 0.4 } });
  });
});

const CREATE = {
  slug: 'clinic-note',
  name: 'Clinic note',
  task: AgentTask.TEXT_GENERATION,
  modelId: 'model-text',
  instruction: { systemPrompt: 'Write the note.' },
};

describe('create', () => {
  it('REFUSES a tenant admin setting a platform-managed path', async () => {
    await expect(
      makeService().create({ ...CREATE, parameters: { generation: { temperature: 0.2, seed: 1 } } } as never),
    ).rejects.toMatchObject({ response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED', paths: ['generation.seed'] } });
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('PASSES a tenant admin setting only tenant-editable paths', async () => {
    await makeService().create({ ...CREATE, parameters: { generation: { temperature: 0.2, maxTokens: 500 }, dna: { enabled: true } } } as never);
    expect(mockAgentRepository.create).toHaveBeenCalledTimes(1);
  });

  it('PASSES a super admin in a customer tenant', async () => {
    clsStore.user = { id: 'user-platform', roles: ['SUPER_ADMIN'] };
    await makeService().create({ ...CREATE, parameters: { generation: { temperature: 0.2, seed: 1 } } } as never);
    expect(mockAgentRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('import', () => {
  function bundle(parameters: Record<string, unknown>) {
    return {
      bundle: {
        kind: 'agent',
        schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
        exportedAt: '2026-10-04T00:00:00.000Z',
        source: { tenantKind: 'tenant', slug: 'clinic-note', version: 1 },
        payload: {
          slug: 'clinic-note',
          name: 'Clinic note',
          description: null,
          task: AgentTask.TEXT_GENERATION,
          modelSlug: 'gpt-x',
          fallbackModelSlugs: [],
          instruction: { systemPrompt: 'Write the note.' },
          parameters,
          inputSchema: null,
          outputSchema: null,
          tools: null,
          tags: [],
          notes: [],
        },
      },
    };
  }

  it('REFUSES a tenant admin importing a bundle that sets a platform-managed path', async () => {
    const service = makeService();
    await expect(service.importBundle(bundle({ generation: { topP: 0.3 } }) as never)).rejects.toMatchObject({
      response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED', paths: ['generation.topP'] },
    });
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });
});
