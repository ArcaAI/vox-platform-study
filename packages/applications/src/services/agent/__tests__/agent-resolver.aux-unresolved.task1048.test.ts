/**
 * TASK-1048 — an ASR agent that names an OPTIONAL auxiliary model (vad / denoise / embedding /
 * punctuation / endpointing) the tenant cannot see no longer refuses the whole resolve with 409.
 * The model is simply not materialised; `buildResolvedAsrSpec` then switches the stage off and
 * reports it (`DIARIZATION_MODEL_MISSING` / `VAD_MODEL_MISSING`), and the core ASR path runs.
 * The PRIMARY model stays a hard refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AgentResolverService } from '../agent-resolver.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const aiModelRepository = { findById: vi.fn(), findBySlug: vi.fn() };
const providerConnections = { resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })) };

const row = (over: Record<string, unknown>) => ({
  id: 'asr',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'sarvam-saaras-v4',
  sourceUri: 'sarvam:saaras-v4',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'API',
  computeType: null,
  provider: null,
  ...over,
});

const asrAgent = (parameters: Record<string, unknown>) => ({
  id: 'agent-1',
  tenantId: TENANT,
  slug: 'sarvam-diarization',
  versionNumber: 1,
  task: AgentTask.SPEECH_TO_TEXT,
  compiledConfig: {
    task: 'SPEECH_TO_TEXT',
    service: 'stt',
    model: { id: 'asr', slug: 'sarvam-saaras-v4', provider: null, taskType: 'AUTOMATIC_SPEECH_RECOGNITION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    tools: [],
  },
});

const make = () =>
  new AgentResolverService(agentRepository as never, fallbackRepository as never, aiModelRepository as never, {} as never, providerConnections as never);

beforeEach(() => {
  vi.clearAllMocks();
  aiModelRepository.findById.mockResolvedValue(row({}));
  aiModelRepository.findBySlug.mockResolvedValue(null);
});

describe('AgentResolverService — unresolvable optional aux models degrade (TASK-1048)', () => {
  it('an invisible embedding / vad slug is skipped, the resolve succeeds with the primary only', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(
      asrAgent({ audioFrontEnd: { vad: { enabled: true, modelSlug: 'gone-vad' }, diarization: { enabled: true, embeddingModelSlug: 'gone-emb' } } }),
    );
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });
    expect(resolved.models.map((m) => [m.role, m.slug])).toEqual([['primary', 'sarvam-saaras-v4']]);
  });

  it('a visible aux slug is still materialised next to a skipped one', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(
      asrAgent({ audioFrontEnd: { vad: { enabled: true, modelSlug: 'silero-vad' }, diarization: { enabled: true, embeddingModelSlug: 'gone-emb' } } }),
    );
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string, slug: string) =>
      tenantId === SYSTEM_TENANT_ID && slug === 'silero-vad' ? row({ id: 'vad', slug }) : null,
    );
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' });
    expect(resolved.models.map((m) => [m.role, m.slug])).toEqual([
      ['primary', 'sarvam-saaras-v4'],
      ['vad', 'silero-vad'],
    ]);
  });

  it('an invisible PRIMARY model is still a refusal (core)', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(asrAgent({}));
    aiModelRepository.findById.mockResolvedValue(null);
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'sarvam-diarization' })).rejects.toBeInstanceOf(ConflictException);
  });
});
