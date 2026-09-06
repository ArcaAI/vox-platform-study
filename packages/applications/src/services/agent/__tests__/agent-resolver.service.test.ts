/** TASK-863 — AgentResolverService: explicit slug, cascade, foreign 404, cloud override + funding tier. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AgentResolverService } from '../agent-resolver.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const aiModelRepository = { findById: vi.fn(), findBySlug: vi.fn() };
const assignments = { resolve: vi.fn() };
const providerConnections = { resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })) };

const model = (over: Record<string, unknown>) => ({
  id: 'm1', tenantId: SYSTEM_TENANT_ID, slug: 'lms-gemma-4-e2b-it-qat', sourceUri: 'hf:google/gemma', sourceRevision: null, localPath: null, checksum: null, format: 'GGUF', computeType: null, provider: 'lm-studio', ...over,
});
const published = (over: Record<string, unknown> = {}) => ({
  id: 'agent-1', tenantId: TENANT, slug: 'clinic-summarizer', versionNumber: 3, task: AgentTask.TEXT_GENERATION,
  compiledConfig: { task: 'TEXT_GENERATION', service: 'llm', model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' }, fallbacks: [], instruction: null, resolvedPrompt: null, parameters: {}, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, tools: [], protocols: ['http'] },
  ...over,
});

function make() {
  return new AgentResolverService(agentRepository as never, fallbackRepository as never, aiModelRepository as never, assignments as never, providerConnections as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  aiModelRepository.findById.mockResolvedValue(model({}));
});

describe('AgentResolverService.resolve', () => {
  it('explicit slug → the visible ACTIVE PUBLISHED row, source=explicit, primary model materialised', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published());
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' });
    expect(resolved).toMatchObject({ slug: 'clinic-summarizer', versionNumber: 3, source: 'explicit', task: 'TEXT_GENERATION' });
    expect(resolved.models[0]).toMatchObject({ role: 'primary', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', tenantId: SYSTEM_TENANT_ID });
    expect(resolved.providerOverride).toBeUndefined();
    expect(assignments.resolve).not.toHaveBeenCalled();
  });

  it('foreign / unknown / unpublished slug → one 404', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
    await expect(make().resolve({ tenantId: TENANT, agentSlug: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a slug of the wrong task is a caller error (400), not a silent substitution', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published());
    await expect(make().resolve({ tenantId: TENANT, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'clinic-summarizer' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no slug → the assignment cascade decides (department → tenant → SYSTEM) and the source is reported', async () => {
    assignments.resolve.mockResolvedValue({ agentSlug: 'platform-summarization', source: 'platform-default' });
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published({ slug: 'platform-summarization', tenantId: SYSTEM_TENANT_ID }));
    const resolved = await make().resolve({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION, departmentId: 'dept-1' });
    expect(assignments.resolve).toHaveBeenCalledWith(TENANT, AgentTask.TEXT_GENERATION, 'dept-1');
    expect(resolved).toMatchObject({ slug: 'platform-summarization', source: 'platform-default', tenantId: SYSTEM_TENANT_ID });
  });

  it('no slug and nothing assigned → 404', async () => {
    assignments.resolve.mockResolvedValue({ agentSlug: null, source: 'platform-default' });
    await expect(make().resolve({ tenantId: TENANT, task: AgentTask.TEXT_GENERATION })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cloud provider → providerOverride derived from the (service, provider) cascade with the funding tier', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published({ compiledConfig: { ...published().compiledConfig, model: { id: 'm2', slug: 'azure-gpt-5.4-mini', provider: 'azure', taskType: 'TEXT_GENERATION' } } }));
    aiModelRepository.findById.mockResolvedValue(model({ id: 'm2', slug: 'azure-gpt-5.4-mini', provider: 'azure' }));
    providerConnections.resolveTenantCloudOverrides.mockResolvedValue({ overrides: { azure: { api_key: 'k', funding: 'platform', deployment_name: 'gpt' } } });
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' });
    expect(providerConnections.resolveTenantCloudOverrides).toHaveBeenCalledWith('llm', TENANT);
    expect(resolved.providerOverride).toMatchObject({ provider: 'azure', api_key: 'k', deployment_name: 'gpt' });
    expect(resolved.fundingTier).toBe('platform');
  });

  it('ASR agent → auxiliary registry models (vad, punctuation) are materialised by slug, tenant then SYSTEM', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(
      published({
        task: AgentTask.SPEECH_TO_TEXT,
        compiledConfig: { ...published().compiledConfig, task: 'SPEECH_TO_TEXT', service: 'stt', model: { id: 'asr', slug: 'arcaai-whisper-large-ml-en-gguf', provider: null, taskType: 'AUTOMATIC_SPEECH_RECOGNITION' }, parameters: { audioFrontEnd: { vad: { modelSlug: 'silero-vad' } }, postProcessing: { punctuation: { modelSlug: 'cadence-punctuation' } } } },
      }),
    );
    aiModelRepository.findById.mockResolvedValue(model({ id: 'asr', slug: 'arcaai-whisper-large-ml-en-gguf', provider: null }));
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string, slug: string) => (tenantId === SYSTEM_TENANT_ID ? model({ id: slug, slug, provider: null }) : null));
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'x' });
    expect(resolved.models.map((m) => [m.role, m.slug])).toEqual([
      ['primary', 'arcaai-whisper-large-ml-en-gguf'],
      ['vad', 'silero-vad'],
      ['punctuation', 'cadence-punctuation'],
    ]);
  });
});

// TASK-880 H-4 — the model row's runtime `_metadata` slice rides the resolved model, and the
// end-of-utterance (endpointing) model bound at `streaming.semantic.modelSlug` is materialised.
describe('AgentResolverService.resolve — model metadata and the endpointing role (TASK-880 H-4)', () => {
  it('carries the model row metaData slice onto the resolved model (absent when the row has none)', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published());
    aiModelRepository.findById.mockResolvedValue(model({ metaData: { asr: { maxDecodeWindowSec: 30, partialWindowSec: 4 }, embedding: { dimension: 256 } } }));
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' });
    expect(resolved.models[0].metaData).toEqual({ asr: { maxDecodeWindowSec: 30, partialWindowSec: 4 }, embedding: { dimension: 256 } });

    aiModelRepository.findById.mockResolvedValue(model({ metaData: null }));
    const bare = await make().resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' });
    expect('metaData' in bare.models[0]).toBe(false);
  });

  it('ASR agent → an endpointing model bound at streaming.semantic.modelSlug is materialised by slug', async () => {
    const base = published().compiledConfig as { parameters: Record<string, unknown> };
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(
      published({
        task: AgentTask.SPEECH_TO_TEXT,
        compiledConfig: {
          ...base,
          task: 'SPEECH_TO_TEXT',
          service: 'stt',
          model: { id: 'asr', slug: 'arcaai-whisper-large-ml-en-gguf', provider: null, taskType: 'AUTOMATIC_SPEECH_RECOGNITION' },
          parameters: { ...base.parameters, streaming: { semantic: { modelSlug: 'eou-classifier' } } },
        },
      }),
    );
    aiModelRepository.findById.mockResolvedValue(model({ id: 'asr', slug: 'arcaai-whisper-large-ml-en-gguf', provider: null }));
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string, slug: string) => (tenantId === SYSTEM_TENANT_ID ? model({ id: slug, slug, provider: null }) : null));
    const resolved = await make().resolve({ tenantId: TENANT, agentSlug: 'x' });
    expect(resolved.models.map((m) => [m.role, m.slug])).toContainEqual(['endpointing', 'eou-classifier']);
  });
});

/**
 * TASK-890 L1 (H-6 runtime half) — a SYSTEM agent's fallback CHAIN under a
 * tenant's CLS.
 *
 * `AgentModelFallback` is tenant-scoped and NOT shared-read, so
 * `findByAgentId(entity.id)` executed under the CALLER's tenant filters away
 * every row of a SYSTEM agent's chain and returns `[]` — a silently
 * fallback-less resolve, not an error. The fix is CONTEXT, not a widening: the
 * chain is read under the AGENT's own tenant, exactly as `runInTenantContext`
 * does for the membership-bounded sync.
 */
describe('TASK-890 H-6 — the fallback chain of a SYSTEM agent resolved by a tenant', () => {
  /** A CLS double that behaves like the real one: `run` inherits, `set` scopes to the run. */
  function clsDouble(initialTenant: string) {
    const stack: string[] = [initialTenant];
    return {
      current: () => stack[stack.length - 1],
      get: (key: string) => (key === 'tenantId' ? stack[stack.length - 1] : null),
      set: (key: string, value: string) => {
        if (key === 'tenantId') stack[stack.length - 1] = value;
      },
      run: async (_opts: unknown, work: () => Promise<unknown>) => {
        stack.push(stack[stack.length - 1]);
        try {
          return await work();
        } finally {
          stack.pop();
        }
      },
    };
  }

  it('materialises the chain the SYSTEM agent actually has', async () => {
    const cls = clsDouble(TENANT);
    // The tenant-scope extension, simulated: the chain is only visible while the
    // ambient tenant IS the agent's own.
    fallbackRepository.findByAgentId.mockImplementation(async () =>
      cls.current() === SYSTEM_TENANT_ID ? [{ modelId: 'm-fb', priority: 1, enabled: true }] : [],
    );
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(published({ slug: 'platform-summarization', tenantId: SYSTEM_TENANT_ID }));
    aiModelRepository.findById.mockImplementation(async (id: string) =>
      id === 'm-fb' ? model({ id: 'm-fb', slug: 'fallback-model' }) : model({}),
    );

    const service = new AgentResolverService(
      agentRepository as never,
      fallbackRepository as never,
      aiModelRepository as never,
      assignments as never,
      providerConnections as never,
      cls as never,
    );
    const resolved = await service.resolve({ tenantId: TENANT, agentSlug: 'platform-summarization' });

    expect(resolved.models.map((m) => m.role)).toEqual(['primary', 'fallback']);
    expect(resolved.models[1]).toMatchObject({ slug: 'fallback-model', priority: 1 });
    // The caller's own context is restored — the wrap must not leak.
    expect(cls.current()).toBe(TENANT);
  });
});
