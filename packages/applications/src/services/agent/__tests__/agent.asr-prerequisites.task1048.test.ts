/**
 * TASK-1048 Lane B — validate/publish reports WARNING findings for speech-to-text prerequisites
 * (diarization model / backend, VAD model). Advisory only (OD-3): never blocking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY } from '@arcaai/types';
import { AgentService } from '../agent.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const clsStore: Record<string, unknown> = { tenantId: TENANT, user: { id: 'user-1', roles: ['TENANT_ADMIN'] } };
const mockClsService = { get: vi.fn((key: string) => clsStore[key]), set: vi.fn(), run: vi.fn(async (_o: unknown, work: () => unknown) => work()) };
const mockAgentRepository = { findByIdVisible: vi.fn(), update: vi.fn(async (_id: string, entity: unknown) => entity) };
const mockFallbackRepository = { findByAgentId: vi.fn(async () => []) };

const ASR_MODEL = {
  id: 'model-asr',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'sarvam-asr',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  provider: 'faster-whisper',
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};
const embeddingModel = (slug: string) => ({ id: `id-${slug}`, tenantId: SYSTEM_TENANT_ID, slug, taskType: 'SPEAKER_EMBEDDING', resourceStatus: ResourceStatusType.ENABLED });
const vadModel = (slug: string) => ({ id: `id-${slug}`, tenantId: SYSTEM_TENANT_ID, slug, taskType: 'VOICE_ACTIVITY_DETECTION', resourceStatus: ResourceStatusType.ENABLED });

const models = new Map<string, Record<string, unknown>>();
const mockAiModelRepository = {
  findById: vi.fn(async () => ASR_MODEL),
  findByTaskTypeSharedRead: vi.fn(async () => []),
  findBySlug: vi.fn(async (tenantId: string, slug: string) => {
    const row = models.get(slug);
    return row && row.tenantId === tenantId ? row : null;
  }),
};
const mockTenantSettings = { resolve: vi.fn() };

function agent(parameters: unknown, task: AgentTask = AgentTask.SPEECH_TO_TEXT) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'sarvam-diarization',
    name: 'Sarvam diarization',
    description: null,
    task,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-asr',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    instruction: null,
    parameters,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    validate: vi.fn(),
  } as never;
}

function makeService() {
  const args = [
    mockAgentRepository,
    mockFallbackRepository,
    mockAiModelRepository,
    { emit: vi.fn() },
    mockClsService,
    { baseClient: { $transaction: vi.fn() } },
    undefined,
    { resolveConnection: vi.fn(async () => ({ source: 'system', encryptedApiKey: new Uint8Array([1]) })), findRow: vi.fn(async () => null) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mockTenantSettings,
  ];
  return new AgentService(...(args as unknown as ConstructorParameters<typeof AgentService>));
}

async function findingsFor(parameters: unknown, task: AgentTask = AgentTask.SPEECH_TO_TEXT) {
  mockAgentRepository.findByIdVisible.mockResolvedValue(agent(parameters, task));
  const validated = await makeService().validate('agent-1');
  return validated.validationReport?.findings ?? [];
}
const asr = (findings: Array<{ code: string }>) => findings.filter((finding) => finding.code.startsWith('ASR_'));

beforeEach(() => {
  vi.clearAllMocks();
  models.clear();
  mockAiModelRepository.findById.mockImplementation(async () => ASR_MODEL);
  mockTenantSettings.resolve.mockReturnValue({ key: STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, value: null, source: 'code-default' });
});

describe('ASR prerequisite findings (TASK-1048 OD-3: WARNING, never blocking)', () => {
  it('diarization on, no embedding slug, no platform default -> ASR_DIARIZATION_MODEL_MISSING (WARNING)', async () => {
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true } } }));
    expect(found).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        code: 'ASR_DIARIZATION_MODEL_MISSING',
        path: 'parameters.audioFrontEnd.diarization.embeddingModelSlug',
        message: expect.stringContaining('SKIPPED'),
      }),
    ]);
  });

  it('an enabled SPEAKER_EMBEDDING model named on the agent -> no finding', async () => {
    models.set('wespeaker', embeddingModel('wespeaker'));
    const found = await findingsFor({ audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'wespeaker' } } });
    expect(asr(found)).toEqual([]);
  });

  it('a named slug that resolves to no usable model -> finding', async () => {
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'ghost' } } }));
    expect(found.map((f) => f.code)).toEqual(['ASR_DIARIZATION_MODEL_MISSING']);
  });

  it('a named slug of the wrong task type is not usable', async () => {
    models.set('silero', vadModel('silero'));
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true, embeddingModelSlug: 'silero' } } }));
    expect(found.map((f) => f.code)).toEqual(['ASR_DIARIZATION_MODEL_MISSING']);
  });

  it('falls back to the platform default setting when the agent names none', async () => {
    models.set('wespeaker', embeddingModel('wespeaker'));
    mockTenantSettings.resolve.mockReturnValue({ key: STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, value: 'wespeaker', source: 'system' });
    const found = await findingsFor({ audioFrontEnd: { diarization: { enabled: true } } });
    expect(asr(found)).toEqual([]);
    expect(mockTenantSettings.resolve).toHaveBeenCalledWith(STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, TENANT);
  });

  it('a platform default that resolves to nothing -> finding', async () => {
    mockTenantSettings.resolve.mockReturnValue({ key: 'k', value: 'ghost', source: 'system' });
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true } } }));
    expect(found.map((f) => f.code)).toEqual(['ASR_DIARIZATION_MODEL_MISSING']);
  });

  it('an unset (fail-closed, raising) platform default is reported as missing, never breaks validate', async () => {
    mockTenantSettings.resolve.mockImplementation(() => {
      throw new Error("Setting 'stt.diarization.defaultEmbeddingModelSlug' is not set");
    });
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true } } }));
    expect(found.map((f) => f.code)).toEqual(['ASR_DIARIZATION_MODEL_MISSING']);
  });

  it('diarization disabled -> no diarization finding', async () => {
    expect(asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: false } } }))).toEqual([]);
  });

  it('a stored non-embedding backend -> ASR_DIARIZATION_BACKEND_UNSUPPORTED', async () => {
    models.set('wespeaker', embeddingModel('wespeaker'));
    const found = asr(await findingsFor({ audioFrontEnd: { diarization: { enabled: true, backend: 'sortformer', embeddingModelSlug: 'wespeaker' } } }));
    expect(found).toEqual([
      expect.objectContaining({ severity: 'WARNING', code: 'ASR_DIARIZATION_BACKEND_UNSUPPORTED', path: 'parameters.audioFrontEnd.diarization.backend' }),
    ]);
  });

  it('vad on with no modelSlug -> ASR_VAD_MODEL_MISSING', async () => {
    const found = asr(await findingsFor({ audioFrontEnd: { vad: { enabled: true } } }));
    expect(found).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        code: 'ASR_VAD_MODEL_MISSING',
        path: 'parameters.audioFrontEnd.vad.modelSlug',
        message: expect.stringContaining('energy'),
      }),
    ]);
  });

  it('vad on with a usable VAD model -> no finding', async () => {
    models.set('silero', vadModel('silero'));
    expect(asr(await findingsFor({ audioFrontEnd: { vad: { enabled: true, modelSlug: 'silero' } } }))).toEqual([]);
  });

  it('a non-ASR agent is never checked', async () => {
    const found = await findingsFor({ audioFrontEnd: { diarization: { enabled: true } } }, AgentTask.TEXT_GENERATION);
    expect(asr(found)).toEqual([]);
  });
});
