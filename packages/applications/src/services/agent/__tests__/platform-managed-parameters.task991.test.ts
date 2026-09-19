/**
 * TASK-991 (owner decision OD-3, 2026-09-19) — the speaker-embedding model is PLATFORM-MANAGED.
 *
 * > The speaker-embedding model used for voice feature extraction is FIXED for every tenant. No
 * > tenant may change it. It stays CONFIG rather than a literal — a PLATFORM admin owns it at the
 * > SYSTEM tier, so it is changed by editing a value, not by shipping a release.
 *
 * Two halves, pinned separately:
 *
 *  1. WHICH paths are locked is derived from the CONTRACT (`readOnly: true` in
 *     `@arcaai/workflow-contract`), not from a list in the service. These tests fail if the
 *     annotation is dropped from `audioFrontEnd.diarization.embeddingModelSlug`, which is the
 *     point — the console reads the same keyword to render the field disabled.
 *  2. A tenant's attempt to change one is REFUSED (403), not ignored. A silently-dropped setting
 *     is how an admin concludes the feature is broken; and the failure this guards against is
 *     itself silent — every enrolled `UserVoiceProfile` is a vector in one model's space, so a
 *     swapped model raises nothing at all, it just never recognises anyone again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../agent.service';
import { platformManagedParameterChanges, platformManagedParameterPaths } from '../platform-managed-parameters';

const EMBEDDING_PATH = 'audioFrontEnd.diarization.embeddingModelSlug';
const TENANT = '50000000-0000-0000-0000-000000000000';

describe('the locked paths come from the contract, not from a list in the service', () => {
  it('locks exactly the speaker-embedding slug on SPEECH_TO_TEXT', () => {
    expect(platformManagedParameterPaths(AgentTask.SPEECH_TO_TEXT)).toEqual([EMBEDDING_PATH]);
  });

  it('locks nothing on the other three tasks — this is a voice-profile rule, not a blanket freeze', () => {
    expect(platformManagedParameterPaths(AgentTask.TEXT_GENERATION)).toEqual([]);
    expect(platformManagedParameterPaths(AgentTask.TEXT_TO_SPEECH)).toEqual([]);
    expect(platformManagedParameterPaths(AgentTask.NAMED_ENTITY_RECOGNITION)).toEqual([]);
  });

  describe('platformManagedParameterChanges', () => {
    const stored = { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } }, decoding: { beamSize: 5 } };

    it('reports nothing when the value is written back unchanged beside a real edit', () => {
      const next = { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } }, decoding: { beamSize: 1 } };
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, next, stored)).toEqual([]);
    });

    it('reports nothing when the path is absent from BOTH — an agent that never diarized stays editable', () => {
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, { decoding: { beamSize: 1 } }, { decoding: { beamSize: 5 } })).toEqual([]);
    });

    it('reports a swap', () => {
      const next = { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } };
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, next, stored)).toEqual([EMBEDDING_PATH]);
    });

    it('reports a REMOVAL — dropping the key is the same breakage by another route', () => {
      // Not a no-op: `buildResolvedAsrSpec` then refuses the spec (409
      // ASR_AGENT_DIARIZATION_MODEL_MISSING) instead of diarizing at all.
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, { audioFrontEnd: { diarization: { enabled: true } } }, stored)).toEqual([
        EMBEDDING_PATH,
      ]);
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, null, stored)).toEqual([EMBEDDING_PATH]);
    });

    it('reports a first-time SET on an agent that stored none', () => {
      const next = { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } };
      expect(platformManagedParameterChanges(AgentTask.SPEECH_TO_TEXT, next, {})).toEqual([EMBEDDING_PATH]);
    });
  });
});

// =============================================================================================
// The write path
// =============================================================================================

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
  findByIdOrNull: vi.fn(),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  update: vi.fn(async (_id: string, entity: unknown) => entity),
};
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn(async (e: unknown) => e), deleteAllForAgent: vi.fn() };
const ASR_MODEL = {
  id: 'model-asr',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'arcaai-whisper-large-ml-en-gguf',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  provider: 'built-in',
  availability: 'AVAILABLE',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const mockAiModelRepository = {
  findById: vi.fn(async () => ASR_MODEL),
  findByIdOrNull: vi.fn(async () => ASR_MODEL),
  findBySlug: vi.fn(async () => null),
  findByTaskTypeSharedRead: vi.fn(async () => []),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockAssignments = { resolve: vi.fn(async () => ({ agentSlug: null, source: 'platform-default' })) };
const mockProviderConnections = {
  resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })),
  findRow: vi.fn(async () => null),
  findDefaultRow: vi.fn(async () => null),
  resolveTenantCloudOverrides: vi.fn(),
};
const mockContextSchemas = { resolveReference: vi.fn(async () => ({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' })) };
const mockReadiness = { getSnapshot: vi.fn(async () => null) };

/** A DRAFT `SPEECH_TO_TEXT` agent that diarizes in a named space — the row the lock protects. */
function sttAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'clinic-asr',
    name: 'Clinic ASR',
    description: null,
    task: AgentTask.SPEECH_TO_TEXT,
    versionNumber: 1,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-asr',
    instruction: null,
    parameters: { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } }, decoding: { beamSize: 5 } },
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
    mockAssignments as never,
    mockProviderConnections as never,
    { findById: vi.fn() } as never,
    { findByVersionNumber: vi.fn() } as never,
    undefined as never,
    undefined as never,
    mockContextSchemas as never,
    mockReadiness as never,
  );
}

/** The parameters the repository was actually asked to persist. */
function persisted(): Record<string, unknown> {
  const call = mockAgentRepository.updateWithVersion.mock.calls[0] as unknown as [string, { parameters: Record<string, unknown> }, number];
  return call[1].parameters;
}

beforeEach(() => {
  // `clearAllMocks` keeps implementations, so every stub a case overrides is reinstated here —
  // otherwise one case's `mockResolvedValue` leaks into the next and the failure reads as a bug
  // in the code under test.
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'user-1', roles: ['TENANT_ADMIN'] };
  mockAgentRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);
  mockAiModelRepository.findById.mockImplementation(async () => ASR_MODEL);
  mockAiModelRepository.findByTaskTypeSharedRead.mockImplementation(async () => []);
  mockFallbackRepository.findByAgentId.mockImplementation(async () => []);
  mockProviderConnections.resolveConnection.mockImplementation(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) }));
  mockAssignments.resolve.mockImplementation(async () => ({ agentSlug: null, source: 'platform-default' }));
  mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
});

describe('AgentService.update — the platform-managed lock (TASK-991 OD-3)', () => {
  it('REFUSES a tenant swapping the embedding model, and writes nothing', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    const swap = { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } };

    await expect(makeService().update('agent-1', { parameters: swap })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService().update('agent-1', { parameters: swap })).rejects.toMatchObject({
      response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED', paths: [EMBEDDING_PATH] },
    });
    expect(mockAgentRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('names the path in the message — a refusal an admin cannot act on is the same as a silent drop', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    await expect(
      makeService().update('agent-1', { parameters: { audioFrontEnd: { diarization: { embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } } }),
    ).rejects.toMatchObject({ response: { message: expect.stringContaining(EMBEDDING_PATH) } });
  });

  it('REFUSES a removal as firmly as a swap', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    await expect(makeService().update('agent-1', { parameters: { audioFrontEnd: { diarization: { enabled: false } } } })).rejects.toMatchObject({
      response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED' },
    });
    expect(mockAgentRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('PASSES an ordinary edit that sends the locked value back unchanged', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    await makeService().update('agent-1', {
      parameters: { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } }, decoding: { beamSize: 1 } },
    });
    expect(mockAgentRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(persisted()).toMatchObject({ decoding: { beamSize: 1 }, audioFrontEnd: { diarization: { embeddingModelSlug: 'wespeaker-voxceleb-resnet34' } } });
  });

  it('PASSES an edit that touches no parameters at all', async () => {
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    await makeService().update('agent-1', { name: 'Clinic ASR v2' });
    expect(mockAgentRepository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('a SUPER_ADMIN on the SYSTEM tier may still change it — that is where OD-3 puts the value', async () => {
    clsStore.tenantId = SYSTEM_TENANT_ID;
    clsStore.user = { id: 'user-platform', roles: ['SUPER_ADMIN'] };
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent({ tenantId: SYSTEM_TENANT_ID }));

    await makeService().update('agent-1', {
      parameters: { audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } },
    });
    expect(persisted()).toMatchObject({ audioFrontEnd: { diarization: { embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } });
  });

  it('a SUPER_ADMIN acting INSIDE a customer tenant is refused — one tenant’s profiles break the same way whoever typed it', async () => {
    clsStore.user = { id: 'user-platform', roles: ['SUPER_ADMIN'] };
    mockAgentRepository.findByIdVisible.mockResolvedValue(sttAgent());
    await expect(
      makeService().update('agent-1', { parameters: { audioFrontEnd: { diarization: { embeddingModelSlug: 'ecapa-tdnn-voxceleb' } } } }),
    ).rejects.toMatchObject({ response: { code: 'AGENT_PARAMETER_PLATFORM_MANAGED' } });
  });
});
