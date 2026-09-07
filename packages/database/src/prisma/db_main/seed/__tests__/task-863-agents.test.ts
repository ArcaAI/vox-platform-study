/**
 * TASK-863 §3.7 — the seeded Agents. Hermetic: the specs are pure data, the row builder is
 * pure, and `seedAgents` runs against an in-memory client. The contract package is imported
 * from SOURCE (the 24-seed test's pattern) so every seeded configuration is checked by the
 * SAME `agentConfigProblems` the service runs at publish, and the checksum is proven to match
 * the contract's `canonicalJson`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TASK_MODEL_TASK_TYPE,
  GLOBAL_AGENT_SPECS,
  PLATFORM_AGENT_ASSIGNMENTS,
  PLATFORM_AGENT_SPECS,
  buildAgentRow,
  buildCompiledConfig,
  canonicalJson,
  checksumOf,
  seedAgents,
  type SeedAgentSpec,
  type SeedAgentsClient,
  type SeedModelRef,
} from '../25-agents';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { agentConfigProblems, canonicalJson: contractCanonicalJson, AGENT_PARAMETER_SCHEMAS } = contract;

/**
 * The registry rows the specs bind, as the catalogue seed defines them (slug → task type /
 * provider / wire id). `wireModelId` is `null` exactly where `seed/ai-models/*` declares none:
 * the three platform-self-host rows resolve by locator, the LM Studio and cloud rows carry the
 * provider-native id (`ai-model-registry-seed.test.ts` pins `wireModelId === sourceUri` there).
 */
const REGISTRY: Record<string, { taskType: string; provider: string | null; wireModelId: string | null }> = {
  'arcaai-whisper-large-ml-en-gguf': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', wireModelId: null },
  'faster-whisper-large-v3-turbo-int8': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', wireModelId: null },
  'azure-speech-stt': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'azure-speech', wireModelId: 'azure://speech-to-text' },
  'sarvam-saaras-v4': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'sarvam', wireModelId: 'saaras:v4' },
  'lms-gemma-4-e2b-it-qat': { taskType: 'TEXT_GENERATION', provider: 'lm-studio', wireModelId: 'gemma-4-e2b-it-qat' },
  kokoro: { taskType: 'TEXT_TO_SPEECH', provider: 'built-in', wireModelId: null },
};
/** Non-null registry lookup: a spec naming a slug outside the catalogue is a test failure, not a type hole. */
function reg(slug: string): { taskType: string; provider: string | null; wireModelId: string | null } {
  const entry = REGISTRY[slug];
  if (!entry) throw new Error(`'${slug}' is not a catalogue model the seed may bind`);
  return entry;
}
const modelRef = (slug: string): SeedModelRef => ({ id: `model-${slug}`, slug, ...reg(slug) });

const ALL_SPECS: SeedAgentSpec[] = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS];

describe('TASK-863 — seeded agent specs', () => {
  it('SYSTEM carries the eight platform defaults, all PUBLISHED and ACTIVE, one per (tenant, slug)', () => {
    expect(PLATFORM_AGENT_SPECS).toHaveLength(8);
    for (const spec of PLATFORM_AGENT_SPECS) {
      expect(spec.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(spec.status).toBe('PUBLISHED');
      expect(spec.isActive).toBe(true);
    }
    expect(PLATFORM_AGENT_SPECS.map((spec) => spec.slug).sort()).toEqual(
      [
        'platform-discharge-summary',
        'platform-grammar-correction',
        'platform-important-findings',
        'platform-presummarization',
        'platform-summarization',
        // TASK-891 — the REALTIME tier of the SOAP summary: same model, same prompt, engine
        // reasoning OFF. Reached by the `phase:live` assignment selector, never by the
        // unqualified row, so it is additive to every tenant that has authored nothing.
        'platform-summarization-live',
        'platform-transcription',
        'platform-tts',
      ].sort(),
    );
    const keys = ALL_SPECS.map((spec) => `${spec.tenantId}/${spec.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ALL_SPECS.map((spec) => spec.id)).size).toBe(ALL_SPECS.length);
  });

  it('Global (the playground tenant) carries the same set as published examples plus an Azure and a Sarvam ASR DRAFT; ArcaAI carries nothing', () => {
    const global = GLOBAL_AGENT_SPECS.filter((spec) => spec.tenantId === SEED_TENANT_ID);
    expect(global).toHaveLength(10);
    expect(global.filter((spec) => spec.status === 'PUBLISHED' && spec.isActive)).toHaveLength(8);
    const drafts = global.filter((spec) => spec.status === 'DRAFT');
    expect(drafts.map((spec) => spec.modelSlug).sort()).toEqual(['azure-speech-stt', 'sarvam-saaras-v4']);
    for (const draft of drafts) expect(draft.isActive).toBe(false);
    expect(ALL_SPECS.some((spec) => spec.tenantId === SEED_CUSTOMER_TENANT_IDS.ARCAAI)).toBe(false);
  });

  it.each(ALL_SPECS.map((spec) => [spec.slug, spec] as const))('%s: binds a model of its task type and passes the contract`s agentConfigProblems (no ERROR)', (_slug, spec) => {
    expect(REGISTRY[spec.modelSlug], `${spec.modelSlug} must be a catalogue model`).toBeDefined();
    const model = reg(spec.modelSlug);
    expect(model.taskType).toBe(AGENT_TASK_MODEL_TASK_TYPE[spec.task]);
    const problems = agentConfigProblems(
      { task: spec.task, instruction: spec.instruction, parameters: spec.parameters, tools: null },
      { model: { slug: spec.modelSlug, taskType: model.taskType, provider: model.provider ?? undefined }, fallbackModels: spec.fallbackModelSlugs.map((slug) => ({ slug, taskType: reg(slug).taskType })) },
    );
    expect(problems.filter((p: { severity: string }) => p.severity === 'ERROR')).toEqual([]);
    // Parameters are declared keys of the task schema (additionalProperties: false at the top).
    const declared = Object.keys(AGENT_PARAMETER_SCHEMAS[spec.task].properties);
    for (const key of Object.keys(spec.parameters)) expect(declared).toContain(key);
  });

  // AMENDED by TASK-891: no longer ONE row per task. A task may hold several rows that differ
  // by TASK-884 selector, and `AgentAssignmentService.resolve` tries the most specific matching
  // one first with the unqualified row last. What must stay true is that exactly one row per
  // task is UNQUALIFIED — that row is what every caller naming no selector resolves, so a
  // second one would make the tier's default ambiguous.
  it('every platform default is a TENANT-scope SYSTEM assignment target for its task, exactly one of them unqualified', () => {
    expect(PLATFORM_AGENT_ASSIGNMENTS.map((a) => a.task).sort()).toEqual(['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_GENERATION', 'TEXT_TO_SPEECH']);
    expect(PLATFORM_AGENT_ASSIGNMENTS.filter((a) => !a.selectorKey).map((a) => a.task).sort()).toEqual([
      'SPEECH_TO_TEXT',
      'TEXT_GENERATION',
      'TEXT_TO_SPEECH',
    ]);
    expect(PLATFORM_AGENT_ASSIGNMENTS.find((a) => a.selectorKey)).toMatchObject({
      task: 'TEXT_GENERATION',
      agentSlug: 'platform-summarization-live',
      selectorKey: 'phase:live',
    });
    for (const assignment of PLATFORM_AGENT_ASSIGNMENTS) {
      const target = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === assignment.agentSlug);
      expect(target?.task).toBe(assignment.task);
    }
  });
});

describe('TASK-863 — buildAgentRow / compiledConfig', () => {
  const asr = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-transcription')!;
  const llm = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-summarization')!;

  it('stamps compiledConfig in the AgentCompiledConfig shape with the task service, model identity, fallback chain and protocols', () => {
    const row = buildAgentRow(asr, modelRef(asr.modelSlug), [modelRef('faster-whisper-large-v3-turbo-int8')], null);
    expect(row.compiledConfig).toMatchObject({
      task: 'SPEECH_TO_TEXT',
      service: 'stt',
      model: { slug: 'arcaai-whisper-large-ml-en-gguf', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in' },
      fallbacks: [{ priority: 0, slug: 'faster-whisper-large-v3-turbo-int8' }],
      protocols: ['http', 'socket'],
    });
    expect(row.compiledConfig?.inputSchema).toMatchObject({ type: 'object' });
    expect(row.status).toBe('PUBLISHED');
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it('the checksum is sha256 over the contract`s canonicalJson — the same bytes AgentService.publish would stamp', () => {
    const compiled = buildCompiledConfig(llm, modelRef(llm.modelSlug), [], { source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: 'Summarise.' });
    expect(canonicalJson(compiled)).toBe(contractCanonicalJson(compiled));
    expect(checksumOf(compiled)).toBe(`sha256:${createHash('sha256').update(contractCanonicalJson(compiled)).digest('hex')}`);
  });

  it('a DRAFT row carries no compiledConfig and no publish stamps', () => {
    const draft = GLOBAL_AGENT_SPECS.find((spec) => spec.slug === 'example-azure-transcription')!;
    const row = buildAgentRow(draft, modelRef(draft.modelSlug), [modelRef('arcaai-whisper-large-ml-en-gguf')], null);
    expect(row).toMatchObject({ status: 'DRAFT', isActive: false, compiledConfig: null, compiledConfigChecksum: null, publishedAt: null });
  });
});

describe('TASK-863 — seedAgents against an in-memory client', () => {
  function fakeClient(options: { models?: string[]; approvedTemplates?: boolean } = {}) {
    const models = (options.models ?? Object.keys(REGISTRY)).map((slug) => ({ id: `model-${slug}`, slug, taskType: reg(slug).taskType, provider: reg(slug).provider, wireModelId: reg(slug).wireModelId }));
    const agents = new Map<string, any>();
    const fallbacks: any[] = [];
    const assignments = new Map<string, any>();
    const client: SeedAgentsClient = {
      aiModel: { findMany: vi.fn(async () => models) },
      promptTemplate: { findUnique: vi.fn(async ({ where }) => ({ id: where.id, status: options.approvedTemplates === false ? 'DRAFT' : 'APPROVED', content: `body of ${where.id}`, approvedVersionNumber: 1, currentVersionNumber: 1 })) },
      promptVersion: { findFirst: vi.fn(async ({ where }) => ({ content: `v${where.versionNumber} of ${where.promptTemplateId}` })) },
      agent: {
        findUnique: vi.fn(async ({ where }) => (agents.has(where.id) ? { id: where.id } : null)),
        create: vi.fn(async ({ data }) => {
          agents.set((data as { id: string }).id, data);
          return data;
        }),
      },
      agentModelFallback: { create: vi.fn(async ({ data }) => fallbacks.push(data)) },
      agentAssignment: {
        findUnique: vi.fn(async ({ where }) => (assignments.has(where.id) ? { id: where.id } : null)),
        create: vi.fn(async ({ data }) => {
          assignments.set((data as { id: string }).id, data);
          return data;
        }),
      },
    };
    return { client, agents, fallbacks, assignments };
  }

  it('seeds every SYSTEM default with its resolved (pinned) template, the fallback links and the four SYSTEM assignments; a second run is a no-op', async () => {
    const { client, agents, fallbacks, assignments } = fakeClient();
    const first = await seedAgents(client);
    expect(first).toEqual({ created: 18, skippedExisting: 0, skippedUnresolvable: 0, assignmentsCreated: 4 });
    const summarization = agents.get(PLATFORM_AGENT_SPECS.find((s) => s.slug === 'platform-summarization')!.id);
    expect(summarization.compiledConfig.resolvedPrompt).toMatchObject({ source: 'template', promptVersionNumber: 1 });
    expect(summarization.compiledConfig.resolvedPrompt.content).toContain('v1 of');
    expect(summarization.compiledConfigChecksum).toMatch(/^sha256:/);
    expect(fallbacks.filter((f) => f.agentId === PLATFORM_AGENT_SPECS[0]!.id)).toHaveLength(1);
    expect([...assignments.values()].map((a) => [a.scope, a.task, a.agentSlug, a.selectorKey])).toEqual([
      ['TENANT', 'SPEECH_TO_TEXT', 'platform-transcription', ''],
      ['TENANT', 'TEXT_GENERATION', 'platform-summarization', ''],
      ['TENANT', 'TEXT_TO_SPEECH', 'platform-tts', ''],
      ['TENANT', 'TEXT_GENERATION', 'platform-summarization-live', 'phase:live'],
    ]);
    for (const row of assignments.values()) expect(row.tenantId).toBe(SYSTEM_TENANT_ID);

    const second = await seedAgents(client);
    expect(second).toEqual({ created: 0, skippedExisting: 18, skippedUnresolvable: 0, assignmentsCreated: 0 });
  });

  it('fails closed: a spec whose model is missing from the SYSTEM registry, or whose template is not APPROVED, is skipped — never seeded broken', async () => {
    const missingKokoro = fakeClient({ models: Object.keys(REGISTRY).filter((slug) => slug !== 'kokoro') });
    const result = await seedAgents(missingKokoro.client);
    expect(result.skippedUnresolvable).toBe(2); // platform-tts + example-tts
    expect([...missingKokoro.agents.values()].some((row) => row.task === 'TEXT_TO_SPEECH')).toBe(false);
    // The TTS assignment cannot point at an agent that was not seeded; the other three (two of
    // them TEXT_GENERATION, one per selector) still do.
    expect(result.assignmentsCreated).toBe(3);

    const unapproved = fakeClient({ approvedTemplates: false });
    const result2 = await seedAgents(unapproved.client);
    // 5 template-bound LLM agents per tenant x 2 tenants are refused (TASK-891 added the live
    // summarization tier, which binds the same SOAP template); inline-prompt, ASR and TTS
    // agents still seed.
    expect(result2.skippedUnresolvable).toBe(10);
    expect(result2.created).toBe(8);
  });
});

/**
 * TASK-890 (L8) — what the seed must now say, and why each is a REGRESSION guard rather than a
 * restatement of the code.
 *
 * 1. `instruction.variables` is a map of BINDINGS (`{ value }` | `{ path }`). The retired
 *    flat-string form is REFUSED by the instruction schema, so a seed that still carried one
 *    would fail every publish of that agent — and the seed is what a fresh environment starts
 *    from, which is the worst place to discover it.
 * 2. `compiledConfig` carries `guardrail` and `contextSchema`, because a seeded row and a
 *    re-published one must be the same artifact down to the checksum.
 */
describe('TASK-890 — the seeded agents on the new instruction and compiled shapes', () => {
  const ALL_SPECS: SeedAgentSpec[] = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS];

  it('no seeded instruction carries the retired flat-string `variables` form', () => {
    for (const spec of ALL_SPECS) {
      const variables = (spec.instruction as Record<string, unknown> | null)?.variables;
      if (variables === undefined) continue;
      expect(variables, `${spec.slug}.instruction.variables`).toBeTypeOf('object');
      for (const [name, binding] of Object.entries(variables as Record<string, unknown>)) {
        expect(binding, `${spec.slug}.instruction.variables.${name}`).toBeTypeOf('object');
        expect(Object.keys(binding as Record<string, unknown>).sort(), `${spec.slug}.instruction.variables.${name}`).toSatisfy(
          (keys: string[]) => keys.length === 1 && (keys[0] === 'value' || keys[0] === 'path'),
        );
      }
    }
  });

  it('every seeded configuration still passes the contract`s own `agentConfigProblems`', () => {
    for (const spec of ALL_SPECS) {
      const problems = agentConfigProblems({
        task: spec.task,
        instruction: spec.instruction ?? null,
        parameters: spec.parameters ?? null,
        inputSchema: null,
        outputSchema: null,
        tools: null,
        contextSchemaId: null,
        contextSchemaVersionNumber: null,
      });
      expect(problems, `${spec.slug}: ${JSON.stringify(problems)}`).toEqual([]);
    }
  });

  it('a PUBLISHED row compiles `guardrail.enabled: true` (absent means ON) and no context pin', () => {
    const llm = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-summarization')!;
    const row = buildAgentRow(llm, modelRef(llm.modelSlug), [], { source: 'inline', content: 'x' });
    expect(row.compiledConfig).toMatchObject({ guardrail: { enabled: true }, contextSchema: null });
    expect(row).toMatchObject({ contextSchemaId: null, contextSchemaVersionNumber: null });
  });

  it('an agent that opts OUT compiles `guardrail.enabled: false`', () => {
    const llm = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-summarization')!;
    const optedOut: SeedAgentSpec = { ...llm, parameters: { ...llm.parameters, guards: { enabled: false } } };
    const compiled = buildCompiledConfig(optedOut, modelRef(llm.modelSlug), [], null);
    expect(compiled).toMatchObject({ guardrail: { enabled: false } });
  });

  /**
   * TASK-890 black-box F9 — `AgentService.compile` freezes the ROUTED id beside the model
   * reference (`compiledConfig.model.wireModelId`), which is what an invocation puts on the wire.
   * The seed builds the same artifact by hand, so a seeded row that omitted the member would
   * differ from a re-published one in both the shape AND the checksum (`canonicalJson` drops no
   * present key), and a seeded agent bound to an LM Studio row would route off the catalogue slug
   * on any path that trusts the frozen value.
   */
  it('a PUBLISHED row freezes `model.wireModelId` exactly as `AgentService.compile` does — the id where the catalogue has one, `null` where it does not', () => {
    const llm = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-summarization')!;
    const compiled = buildCompiledConfig(llm, modelRef(llm.modelSlug), [], { source: 'inline', content: 'x' }) as { model: Record<string, unknown> };
    expect(compiled.model).toEqual({ id: 'model-lms-gemma-4-e2b-it-qat', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION', wireModelId: 'gemma-4-e2b-it-qat' });

    const asr = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'platform-transcription')!;
    const selfHosted = buildCompiledConfig(asr, modelRef(asr.modelSlug), [], null) as { model: Record<string, unknown> };
    expect(selfHosted.model.wireModelId, 'a platform-self-host row declares no wire id — the member is present and null, never absent').toBeNull();
    expect(Object.keys(selfHosted.model).sort()).toEqual(['id', 'provider', 'slug', 'taskType', 'wireModelId']);
  });
});
