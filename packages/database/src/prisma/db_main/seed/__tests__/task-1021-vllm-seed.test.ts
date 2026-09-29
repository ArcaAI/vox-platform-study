/**
 * TASK-1010 phase B (OD-9 / OD-12), reshaped by TASK-1021 (D-11 / D-13) — the vLLM registry row,
 * the SYSTEM `stt/vllm` connection that says where the engine lives, and the ONE agent that reaches
 * the row.
 *
 * D-13: the vLLM serving target gets its OWN SYSTEM `AiModel` row over the same private HF
 * checkpoint as the transformers row — `provider: 'vllm'`, `libraryName: 'vllm'`, `servedBy: 'vllm'`
 * — so its usability follows the SYSTEM `stt/vllm` connection. D-11: its engine sizing rides the row
 * (`_metadata.serving`), beside the serving facts on `_metadata.asr` (TASK-1010 OD-8).
 *
 * OD-12 + the owner rule "selection is always through an Agent": ONE published SPEECH_TO_TEXT agent
 * binds the row. It is authored in the Global PLAYGROUND tenant only — never SYSTEM (so the reference
 * set never clones it into a customer tenant, TASK-890 OD-M), never assigned (so no assignment
 * cascade or governing workflow picks it up implicitly); only an explicit `agentSlug` reaches it.
 *
 * Hermetic: pure data and an in-memory client, like the sibling seed tests. The contract is
 * imported from SOURCE, exactly as `task-930-agent-publish-gate.test.ts` does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAiModelAsrProfile } from '@arcaai/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { DEFAULT_AI_MODELS, RETIRED_AI_MODEL_SLUGS } from '../06-ai-models';
import {
  GLOBAL_AGENT_ASSIGNMENTS,
  GLOBAL_AGENT_SPECS,
  GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS,
  PLATFORM_AGENT_ASSIGNMENTS,
  PLATFORM_AGENT_SPECS,
  VLLM_ASR_AGENT_SLUG,
  seedGlobalPlaygroundOnlyAgents,
  type SeedAgentsClient,
} from '../25-agents';
import { ARCAAI_AGENT_SPECS } from '../29-arcaai-agents-and-workflows';
import {
  PLATFORM_SELF_HOST_CONNECTIONS,
  SELF_HOST_PLACEHOLDER_API_KEY,
  SYSTEM_AI_PROVIDER_CONNECTIONS,
  seedAiProviderConnection,
} from '../17-ai-provider-connection';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '..');
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { agentConfigProblems } = contract;

const VLLM_SLUG = 'arcaai-whisper-large-ml-en-vllm';
const VLLM_ID = '80000000-0000-0000-0001-000000000026';

/** Every `.ts` source under the seed directory (tests excluded), for the static id/slug scans. */
function seedSources(dir = SEED_DIR): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...seedSources(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ file: path.relative(SEED_DIR, full), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

const vllmRow = () => DEFAULT_AI_MODELS.find((model) => model.slug === VLLM_SLUG);
const agentSpec = () => GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS.find((spec) => spec.slug === VLLM_ASR_AGENT_SLUG);

describe('the vLLM registry row (OD-9, D-13)', () => {
  it('is ONE SYSTEM row served by vllm, SAFETENSOR/vllm/float16, self-hosted ASR', () => {
    expect(DEFAULT_AI_MODELS.filter((model) => model.slug === VLLM_SLUG)).toHaveLength(1);
    expect(vllmRow()).toMatchObject({
      id: VLLM_ID,
      tenantId: SYSTEM_TENANT_ID,
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      servedBy: 'vllm',
      format: 'SAFETENSOR',
      libraryName: 'vllm',
      computeType: 'float16',
      deploymentKind: 'SELF_HOSTED',
      // D-13 — an ENGINE_SERVED provider: usability follows the SYSTEM `stt/vllm` connection.
      provider: 'vllm',
    });
  });

  it('declares its engine sizing on _metadata.serving (D-11) — vramGiB is what sizes the GPU', () => {
    const serving = (vllmRow()!.metaData as Record<string, any>).serving;
    expect(serving).toEqual({ vramGiB: 5, maxNumSeqs: 64 });
  });

  it('points at the SAME private HF checkpoint (and revision) as the transformers row', () => {
    const transformers = DEFAULT_AI_MODELS.find((model) => model.slug === 'arcaai-whisper-large-ml-en');
    expect(transformers).toBeDefined();
    expect(vllmRow()!.sourceUri).toBe(transformers!.sourceUri);
    expect(vllmRow()!.sourceRevision).toBe(transformers!.sourceRevision);
  });

  it('declares its serving facts on _metadata.asr, and they survive the shared parser untouched (OD-8)', () => {
    const { profile, rejected } = parseAiModelAsrProfile(vllmRow()!.metaData?.asr);
    expect(rejected).toEqual([]);
    // Whisper's decoder context (`max_target_positions`) is 448 tokens.
    expect(profile).toEqual({ quantization: 'none', maxModelLen: 448 });
  });

  it('is nobody`s platform default and was never retired', () => {
    expect(vllmRow()!.isPlatformDefaultFor ?? []).toEqual([]);
    expect(RETIRED_AI_MODEL_SLUGS).not.toContain(VLLM_SLUG);
  });

  it('has an id no other seed row uses — a silent id collision froze the wrong prompt once (TASK-1001)', () => {
    const hits = seedSources().filter(({ text }) => text.includes(VLLM_ID));
    expect(hits.map(({ file }) => file)).toEqual(['ai-models/audio.ts']);
    expect(hits[0]!.text.split(VLLM_ID).length - 1).toBe(1);
    expect(new Set(DEFAULT_AI_MODELS.map((model) => model.id)).size).toBe(DEFAULT_AI_MODELS.length);
  });
});

describe('the Global-only vLLM agent (OD-12)', () => {
  it('is ONE published SPEECH_TO_TEXT agent in the Global playground, bound to the vLLM row, with no fallback', () => {
    expect(GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS).toHaveLength(1);
    expect(agentSpec()).toMatchObject({
      tenantId: SEED_TENANT_ID,
      task: 'SPEECH_TO_TEXT',
      modelSlug: VLLM_SLUG,
      fallbackModelSlugs: [],
      status: 'PUBLISHED',
      isActive: true,
      provenance: null,
    });
  });

  it('is never SYSTEM content, so the reference set can never clone it into a customer tenant', () => {
    const everywhereElse = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS];
    expect(everywhereElse.map((spec) => spec.slug)).not.toContain(VLLM_ASR_AGENT_SLUG);
    expect(GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS.every((spec) => spec.tenantId === SEED_TENANT_ID)).toBe(true);
  });

  it('is never assigned and named by no workflow — only an explicit agentSlug reaches it', () => {
    for (const assignment of [...PLATFORM_AGENT_ASSIGNMENTS, ...GLOBAL_AGENT_ASSIGNMENTS]) {
      expect(assignment.agentSlug).not.toBe(VLLM_ASR_AGENT_SLUG);
    }
    // No other seed source (assignments of phase 29, workflow graphs, consultations) spells it.
    const mentions = seedSources().filter(({ text }) => text.includes(VLLM_ASR_AGENT_SLUG));
    expect(mentions.map(({ file }) => file)).toEqual(['25-agents.ts']);
  });

  it('has an agent id in its own block, used by nothing else', () => {
    const id = agentSpec()!.id;
    expect(id).toMatch(/^9c000000-0000-0000-0006-/);
    const allIds = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS, ...GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS].map(
      (spec) => spec.id,
    );
    expect(allIds.filter((candidate) => candidate === id)).toHaveLength(1);
  });

  it('passes the publish gate the API enforces, with the bound model`s declared capabilities', () => {
    const spec = agentSpec()!;
    const model = vllmRow()!;
    const meta = (model.metaData ?? {}) as Record<string, unknown>;
    const caps = (meta.capabilities as Record<string, unknown> | undefined) ?? meta;
    const problems = agentConfigProblems(
      {
        task: spec.task,
        instruction: spec.instruction,
        parameters: spec.parameters,
        inputSchema: null,
        outputSchema: spec.outputSchema ?? null,
        tools: null,
        contextSchemaId: null,
        contextSchemaVersionNumber: null,
      },
      {
        model: { slug: model.slug, taskType: String(model.taskType), provider: model.provider ?? undefined },
        fallbackModels: [],
        capabilities: {
          supportedGenerationParams: Array.isArray(caps.supportedGenerationParams) ? (caps.supportedGenerationParams as string[]) : undefined,
          label: `${model.provider ?? 'local'}/${model.slug}`,
        },
      },
    );
    expect(
      problems.filter((problem: { severity: string }) => problem.severity === 'ERROR'),
      JSON.stringify(problems),
    ).toEqual([]);
  });
});

describe('seedGlobalPlaygroundOnlyAgents against an in-memory client', () => {
  function memoryClient() {
    const agents = new Map<string, any>();
    const fallbacks: any[] = [];
    const assignments: any[] = [];
    const client: SeedAgentsClient = {
      aiModel: {
        findMany: async ({ where }) =>
          DEFAULT_AI_MODELS.filter((model) => model.tenantId === where.tenantId).map((model) => ({
            id: model.id,
            slug: model.slug,
            taskType: String(model.taskType),
            provider: model.provider ?? null,
            wireModelId: model.wireModelId ?? null,
          })),
      },
      promptTemplate: { findUnique: async () => null },
      promptVersion: { findFirst: async () => null },
      agent: {
        findUnique: async ({ where }) => (agents.has(where.id) ? { id: where.id } : null),
        create: async ({ data }) => {
          agents.set((data as any).id, data);
          return data;
        },
      },
      agentModelFallback: { create: async ({ data }) => fallbacks.push(data) },
      agentAssignment: {
        findUnique: async () => null,
        create: async ({ data }) => assignments.push(data),
      },
    };
    return { client, agents, fallbacks, assignments };
  }

  it('creates the agent PUBLISHED with a compiled config frozen on the vLLM row, and nothing else', async () => {
    const { client, agents, fallbacks, assignments } = memoryClient();
    expect(await seedGlobalPlaygroundOnlyAgents(client)).toMatchObject({
      created: 1,
      skippedExisting: 0,
      skippedUnresolvable: 0,
      assignmentsCreated: 0,
    });
    const row = agents.get(agentSpec()!.id);
    expect(row).toMatchObject({ tenantId: SEED_TENANT_ID, slug: VLLM_ASR_AGENT_SLUG, status: 'PUBLISHED', modelId: VLLM_ID });
    expect(row.compiledConfig.model).toMatchObject({ id: VLLM_ID, slug: VLLM_SLUG, taskType: 'AUTOMATIC_SPEECH_RECOGNITION' });
    expect(row.compiledConfig.fallbacks).toEqual([]);
    expect(row.compiledConfigChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fallbacks).toEqual([]);
    expect(assignments).toEqual([]);
  });

  it('is create-only: a second run skips the existing row (a PUBLISHED agent is immutable)', async () => {
    const { client } = memoryClient();
    await seedGlobalPlaygroundOnlyAgents(client);
    expect(await seedGlobalPlaygroundOnlyAgents(client)).toMatchObject({ created: 0, skippedExisting: 1 });
  });
});

describe('TASK-1021 — the agent lost its spike suffix, and stays playground-only', () => {
  it('is named realtime-transcription-vllm', () => {
    expect(VLLM_ASR_AGENT_SLUG).toBe('realtime-transcription-vllm');
    expect(agentSpec()).toMatchObject({ slug: 'realtime-transcription-vllm', tenantId: SEED_TENANT_ID, modelSlug: VLLM_SLUG });
  });
});

describe('TASK-1021 — the SYSTEM stt/vllm connection (where the engine lives)', () => {
  const vllmConnection = () => SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => c.service === 'stt' && c.provider === 'vllm');

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is ONE enabled SYSTEM row, the platform self-host placeholder key, 32 in-flight decodes', () => {
    expect(SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'stt' && c.provider === 'vllm')).toHaveLength(1);
    expect(vllmConnection()).toMatchObject({
      tenantId: SYSTEM_TENANT_ID,
      baseUrl: 'http://hope-vllm-asr:8867/v1',
      maxConcurrent: 32,
      apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
      enabled: true,
    });
    // Classified as an endpoint the PLATFORM runs, so the keyless-row backfill covers it.
    expect(PLATFORM_SELF_HOST_CONNECTIONS).toContain('stt:vllm');
  });

  it('has an id no other connection row uses', () => {
    const ids = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes its address from SEED_VLLM_ASR_BASE_URL when the environment being seeded sets one', async () => {
    vi.stubEnv('SEED_VLLM_ASR_BASE_URL', 'http://127.0.0.1:8867/v1');
    vi.resetModules();
    const fresh = await import('../17-ai-provider-connection');
    expect(fresh.SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => c.service === 'stt' && c.provider === 'vllm')!.baseUrl).toBe('http://127.0.0.1:8867/v1');
  });

  it('writes maxConcurrent onto the created row', async () => {
    const created: any[] = [];
    const client = {
      aiProviderConnection: {
        findFirst: async () => null,
        create: async ({ data }: { data: any }) => created.push(data),
        update: async () => undefined,
      },
    };
    await seedAiProviderConnection(client as any);
    const row = created.find((data) => data.service === 'stt' && data.provider === 'vllm');
    expect(row).toMatchObject({
      slug: 'vllm',
      defaultForProvider: 'vllm',
      baseUrl: 'http://hope-vllm-asr:8867/v1',
      maxConcurrent: 32,
      enabled: true,
    });
  });
});
