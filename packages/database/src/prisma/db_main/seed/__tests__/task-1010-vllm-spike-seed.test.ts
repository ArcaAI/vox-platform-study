/**
 * TASK-1010 phase B (OD-9 / OD-12) — the vLLM registry row and the ONE agent that reaches it.
 *
 * OD-9: the vLLM serving target gets its OWN SYSTEM `AiModel` row (`servedBy: asr-vllm`), over the
 * same private HF checkpoint as the transformers row, carrying its serving facts on
 * `_metadata.asr` (OD-8).
 *
 * OD-12 + the owner rule "selection is always through an Agent": the bench resolves a spec by
 * `agentSlug`, so ONE published SPEECH_TO_TEXT agent binds the row. It is authored in the Global
 * PLAYGROUND tenant only — never SYSTEM (so the reference set never clones it into a customer
 * tenant, TASK-890 OD-M), never assigned (so no assignment cascade or governing workflow picks it
 * up implicitly); only an explicit `agentSlug` reaches it.
 *
 * Hermetic: pure data and an in-memory client, like the sibling seed tests. The contract is
 * imported from SOURCE, exactly as `task-930-agent-publish-gate.test.ts` does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAiModelAsrProfile } from '@arcaai/types';
import { describe, expect, it } from 'vitest';

import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { DEFAULT_AI_MODELS, RETIRED_AI_MODEL_SLUGS } from '../06-ai-models';
import {
  GLOBAL_AGENT_ASSIGNMENTS,
  GLOBAL_AGENT_SPECS,
  GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS,
  PLATFORM_AGENT_ASSIGNMENTS,
  PLATFORM_AGENT_SPECS,
  VLLM_SPIKE_AGENT_SLUG,
  seedGlobalPlaygroundOnlyAgents,
  type SeedAgentsClient,
} from '../25-agents';
import { ARCAAI_AGENT_SPECS } from '../29-arcaai-agents-and-workflows';

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
const spikeSpec = () => GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS.find((spec) => spec.slug === VLLM_SPIKE_AGENT_SLUG);

describe('the vLLM registry row (OD-9)', () => {
  it('is ONE SYSTEM row served by asr-vllm, SAFETENSOR/transformers/float16, self-hosted ASR', () => {
    expect(DEFAULT_AI_MODELS.filter((model) => model.slug === VLLM_SLUG)).toHaveLength(1);
    expect(vllmRow()).toMatchObject({
      id: VLLM_ID,
      tenantId: SYSTEM_TENANT_ID,
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      servedBy: 'asr-vllm',
      format: 'SAFETENSOR',
      // HF-cache layout on publish (`HF_CACHE_LIBRARIES`), so vLLM is handed a local directory.
      libraryName: 'transformers',
      computeType: 'float16',
      deploymentKind: 'SELF_HOSTED',
      provider: 'built-in',
    });
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

describe('the Global-only vLLM spike agent (OD-12)', () => {
  it('is ONE published SPEECH_TO_TEXT agent in the Global playground, bound to the vLLM row, with no fallback', () => {
    expect(GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS).toHaveLength(1);
    expect(spikeSpec()).toMatchObject({
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
    expect(everywhereElse.map((spec) => spec.slug)).not.toContain(VLLM_SPIKE_AGENT_SLUG);
    expect(GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS.every((spec) => spec.tenantId === SEED_TENANT_ID)).toBe(true);
  });

  it('is never assigned and named by no workflow — only an explicit agentSlug reaches it', () => {
    for (const assignment of [...PLATFORM_AGENT_ASSIGNMENTS, ...GLOBAL_AGENT_ASSIGNMENTS]) {
      expect(assignment.agentSlug).not.toBe(VLLM_SPIKE_AGENT_SLUG);
    }
    // No other seed source (assignments of phase 29, workflow graphs, consultations) spells it.
    const mentions = seedSources().filter(({ text }) => text.includes(VLLM_SPIKE_AGENT_SLUG));
    expect(mentions.map(({ file }) => file)).toEqual(['25-agents.ts']);
  });

  it('has an agent id in its own block, used by nothing else', () => {
    const id = spikeSpec()!.id;
    expect(id).toMatch(/^9c000000-0000-0000-0006-/);
    const allIds = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS, ...GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS].map((spec) => spec.id);
    expect(allIds.filter((candidate) => candidate === id)).toHaveLength(1);
  });

  it('passes the publish gate the API enforces, with the bound model`s declared capabilities', () => {
    const spec = spikeSpec()!;
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
    expect(problems.filter((problem: { severity: string }) => problem.severity === 'ERROR'), JSON.stringify(problems)).toEqual([]);
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
    expect(await seedGlobalPlaygroundOnlyAgents(client)).toMatchObject({ created: 1, skippedExisting: 0, skippedUnresolvable: 0, assignmentsCreated: 0 });
    const row = agents.get(spikeSpec()!.id);
    expect(row).toMatchObject({ tenantId: SEED_TENANT_ID, slug: VLLM_SPIKE_AGENT_SLUG, status: 'PUBLISHED', modelId: VLLM_ID });
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
