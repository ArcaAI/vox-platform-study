/**
 * TASK-930 §8.3 — the seeded Agents: Global authors five, SYSTEM carries the IDENTICAL five as
 * the promoted copy (provenance → Global), and both tenants assign one per task.
 *
 * Hermetic: specs are pure data, the row builder is pure, `seedAgents` runs against an in-memory
 * client. The contract is imported from SOURCE so every configuration the contract KNOWS is
 * checked by the same `agentConfigProblems` the service runs at publish. NOTE: this branch's
 * contract predates lane N's `NAMED_ENTITY_RECOGNITION`, so the NER agent is pinned against the
 * INTERFACES §2.3 literal instead and skipped for `agentConfigProblems` — see the report.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TASK_MODEL_TASK_TYPE,
  GLOBAL_AGENT_ASSIGNMENTS,
  GLOBAL_AGENT_SPECS,
  NER_IO_DEFAULTS,
  PLATFORM_AGENT_ASSIGNMENTS,
  PLATFORM_AGENT_SPECS,
  SEEDED_AGENT_SLUGS,
  buildAgentRow,
  buildCompiledConfig,
  canonicalJson,
  checksumOf,
  seedAgents,
  type SeedAgentSpec,
  type SeedAgentsClient,
  type SeedModelRef,
} from '../25-agents';
import { GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES, SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID, TEMPLATE_IDS } from '../07-prompt-template';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { agentConfigProblems, canonicalJson: contractCanonicalJson, AGENT_PARAMETER_SCHEMAS, AGENT_TASKS } = contract;

const REGISTRY: Record<string, { taskType: string; provider: string | null; wireModelId: string | null }> = {
  'arcaai-whisper-large-ml-en-gguf-q8_0': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', wireModelId: null },
  'arcaai-whisper-large-ml-en-gguf': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', wireModelId: null },
  'faster-whisper-large-v3-turbo-int8': { taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', wireModelId: null },
  'medical-ner': { taskType: 'TOKEN_CLASSIFICATION', provider: 'built-in', wireModelId: null },
  'lms-gemma-4-e2b-it-qat': { taskType: 'TEXT_GENERATION', provider: 'lm-studio', wireModelId: 'gemma-4-e2b-it-qat' },
  kokoro: { taskType: 'TEXT_TO_SPEECH', provider: 'built-in', wireModelId: null },
};
function reg(slug: string) {
  const entry = REGISTRY[slug];
  if (!entry) throw new Error(`'${slug}' is not a catalogue model the seed may bind`);
  return entry;
}
const modelRef = (slug: string): SeedModelRef => ({ id: `model-${slug}`, slug, ...reg(slug) });
const ALL_SPECS: SeedAgentSpec[] = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS];
const contractKnows = (task: string) => (AGENT_TASKS as readonly string[]).includes(task);

describe('TASK-930 §8.3 — Global and SYSTEM carry the identical agent set', () => {
  it('seven slugs, one per tenant, all PUBLISHED + ACTIVE; ids unique', () => {
    // TASK-932 D-9 added the sixth: `case-notes-pre-summary`, the realtime WARM START.
    // TASK-974 D-1 added the seventh: `dna-writing-style-analyst`, the PLATFORM HIDDEN agent —
    // seeded into both tenants exactly like the others (the difference is that no tenant is ever
    // provisioned a COPY of it, and it carries no assignment).
    expect([...SEEDED_AGENT_SLUGS].sort()).toEqual([
      'case-notes-pre-summary',
      'casenote-finalization',
      'dna-writing-style-analyst',
      'general-medicine-summarization',
      'medical-ner',
      'realtime-transcription',
      'text-to-speech',
    ]);
    for (const specs of [PLATFORM_AGENT_SPECS, GLOBAL_AGENT_SPECS]) {
      expect(specs.map((spec) => spec.slug).sort()).toEqual([...SEEDED_AGENT_SLUGS].sort());
      for (const spec of specs) expect(spec).toMatchObject({ status: 'PUBLISHED', isActive: true });
    }
    expect(PLATFORM_AGENT_SPECS.every((spec) => spec.tenantId === SYSTEM_TENANT_ID)).toBe(true);
    expect(GLOBAL_AGENT_SPECS.every((spec) => spec.tenantId === SEED_TENANT_ID)).toBe(true);
    expect(new Set(ALL_SPECS.map((spec) => spec.id)).size).toBe(ALL_SPECS.length);
  });

  it('SYSTEM rows are the promoted copy: provenance points at the Global row of the same slug; Global rows carry none', () => {
    for (const system of PLATFORM_AGENT_SPECS) {
      const global = GLOBAL_AGENT_SPECS.find((spec) => spec.slug === system.slug)!;
      expect(system.provenance).toEqual({ sourceAgentId: global.id, sourceTenantId: SEED_TENANT_ID, sourceSlug: global.slug, sourceVersionNumber: 1 });
      expect(global.provenance).toBeNull();
      // identical configuration apart from the template id each tenant owns and the tier tag
      const strip = (spec: SeedAgentSpec) => ({ ...spec, id: '', tenantId: '', provenance: null, instruction: null, tags: spec.tags.filter((tag) => !tag.startsWith('tier:')) });
      expect(strip(system)).toEqual(strip(global));
    }
  });

  it.each(ALL_SPECS.map((spec) => [`${spec.tenantId === SYSTEM_TENANT_ID ? 'SYSTEM' : 'Global'}/${spec.slug}`, spec] as const))(
    '%s binds a model of its task type and passes the contract`s agentConfigProblems (no ERROR) where the contract knows the task',
    (_label, spec) => {
      const model = reg(spec.modelSlug);
      expect(model.taskType).toBe(AGENT_TASK_MODEL_TASK_TYPE[spec.task]);
      for (const fallback of spec.fallbackModelSlugs) expect(reg(fallback).taskType).toBe(model.taskType);
      if (!contractKnows(spec.task)) return;
      const problems = agentConfigProblems(
        { task: spec.task, instruction: spec.instruction, parameters: spec.parameters, inputSchema: null, outputSchema: spec.outputSchema ?? null, tools: null, contextSchemaId: null, contextSchemaVersionNumber: null },
        { model: { slug: spec.modelSlug, taskType: model.taskType, provider: model.provider ?? undefined }, fallbackModels: spec.fallbackModelSlugs.map((slug) => ({ slug, taskType: reg(slug).taskType })) },
      );
      expect(problems.filter((p: { severity: string }) => p.severity === 'ERROR'), JSON.stringify(problems)).toEqual([]);
      const declared = Object.keys(AGENT_PARAMETER_SCHEMAS[spec.task].properties);
      for (const key of Object.keys(spec.parameters)) expect(declared).toContain(key);
    },
  );

  it('the NER agent is the INTERFACES §2 shape: TOKEN_CLASSIFICATION model, one-shot http, the §2.3 IO defaults', () => {
    for (const ner of ALL_SPECS.filter((spec) => spec.slug === 'medical-ner')) {
      expect(ner.task).toBe('NAMED_ENTITY_RECOGNITION');
      expect(ner.modelSlug).toBe('medical-ner');
      const compiled = buildCompiledConfig(ner, modelRef('medical-ner'), [], null) as Record<string, any>;
      expect(compiled.protocols).toEqual(['http']);
      expect(compiled.inputSchema).toEqual(NER_IO_DEFAULTS.inputSchema);
      expect(compiled.outputSchema).toEqual(NER_IO_DEFAULTS.outputSchema);
      expect(compiled.inputSchema).toEqual({ type: 'object', properties: { text: { type: 'string' }, language: { type: 'string' } }, required: ['text'], additionalProperties: false });
      expect(compiled.outputSchema.properties.entities.items.required).toEqual(['text', 'label', 'start', 'end']);
    }
  });

  it('general-medicine-summarization binds the tenant`s own General Medicine template and populates EVERY declared variable (F6)', () => {
    for (const spec of ALL_SPECS.filter((s) => s.slug === 'general-medicine-summarization')) {
      const instruction = spec.instruction as Record<string, any>;
      expect(instruction.promptTemplateId).toBe(spec.tenantId === SYSTEM_TENANT_ID ? SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID : TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY);
      expect(instruction.promptVersionNumber).toBe(1);
      expect(Object.keys(instruction.variables).sort()).toEqual([...GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES].sort());
      for (const name of ['visit_type', 'current_department', 'language', 'safe_age', 'safe_dob', 'safe_gender', 'chief_complaint', 'formatted_vitals', 'formatted_previous_visits']) {
        expect(instruction.variables[name]).toEqual({ path: `trigger.context.${name}` });
      }
      // the document template SHAPES ride as constants (no document-template binding kind exists)
      expect(instruction.variables.new_visit_headings.value).toContain('Presenting Complaints');
      expect(instruction.variables.revisit_headings.value).toContain('Last Visit Complaints');
      expect(spec.parameters).toMatchObject({ guards: { enabled: true } });
    }
  });

  it('casenote-finalization is an inline system prompt with the §8.3 output schema, guards on, and NO responseFormat (the schema is the format — INTERFACES §5)', () => {
    for (const spec of ALL_SPECS.filter((s) => s.slug === 'casenote-finalization')) {
      expect((spec.instruction as any).systemPrompt).toMatch(/redact/i);
      expect(spec.outputSchema).toMatchObject({ type: 'object', required: ['case_note', 'redactions'] });
      expect((spec.outputSchema as any).properties.redactions.items.required).toEqual(['text', 'label']);
      expect(spec.parameters).toMatchObject({ guards: { enabled: true } });
      expect((spec.parameters as any).responseFormat).toBeUndefined();
      const row = buildAgentRow(spec, modelRef(spec.modelSlug), [], { source: 'inline', content: 'x' });
      expect(row.outputSchema).toEqual(spec.outputSchema);
      expect((row.compiledConfig as any).outputSchema).toEqual(spec.outputSchema);
    }
  });

  it('each tenant assigns exactly one UNQUALIFIED agent per task at TENANT scope', () => {
    for (const assignments of [PLATFORM_AGENT_ASSIGNMENTS, GLOBAL_AGENT_ASSIGNMENTS]) {
      const unqualified = assignments.filter((a) => !a.selectorKey);
      expect(unqualified.map((a) => [a.task, a.agentSlug]).sort()).toEqual([
        ['NAMED_ENTITY_RECOGNITION', 'medical-ner'],
        ['SPEECH_TO_TEXT', 'realtime-transcription'],
        ['TEXT_GENERATION', 'general-medicine-summarization'],
        ['TEXT_TO_SPEECH', 'text-to-speech'],
      ]);
    }
  });

  it('TASK-932 — the warm start is the ONE qualified row, and an unqualified request can never see it', () => {
    for (const assignments of [PLATFORM_AGENT_ASSIGNMENTS, GLOBAL_AGENT_ASSIGNMENTS]) {
      const qualified = assignments.filter((a) => a.selectorKey);
      expect(qualified).toHaveLength(1);
      expect(qualified[0]).toMatchObject({ task: 'TEXT_GENERATION', agentSlug: 'case-notes-pre-summary', selectorKey: 'phase:pre-summary' });
      // `AgentAssignmentService.tierCandidates` admits a row whose selector is a SUBSET of the
      // request's tags, so a request carrying none sees only the unqualified rows. Two
      // unqualified TEXT_GENERATION rows in one tier WOULD be a coin toss; there is exactly one.
      expect(assignments.filter((a) => a.task === 'TEXT_GENERATION' && !a.selectorKey)).toHaveLength(1);
    }
    // Ids are unique across BOTH tenants' assignment blocks (SYSTEM 1-5, Global 11-15).
    const ids = [...PLATFORM_AGENT_ASSIGNMENTS, ...GLOBAL_AGENT_ASSIGNMENTS].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the checksum is sha256 over the contract`s canonicalJson', () => {
    const llm = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'general-medicine-summarization')!;
    const compiled = buildCompiledConfig(llm, modelRef(llm.modelSlug), [], { source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: 'Summarise.' });
    expect(canonicalJson(compiled)).toBe(contractCanonicalJson(compiled));
    expect(checksumOf(compiled)).toBe(`sha256:${createHash('sha256').update(contractCanonicalJson(compiled)).digest('hex')}`);
    expect(compiled).toMatchObject({ guardrail: { enabled: true }, contextSchema: null, model: { wireModelId: 'gemma-4-e2b-it-qat' } });
  });
});

describe('TASK-930 — seedAgents against an in-memory client', () => {
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

  it('seeds fourteen agents (7 SYSTEM + 7 Global), their fallback chains and ten assignments; a second run is a no-op', async () => {
    const { client, agents, fallbacks, assignments } = fakeClient();
    const first = await seedAgents(client);
    // Ten assignments, not fourteen: the DNA analyst is deliberately unassigned (TASK-974 D-1),
    // and NER/TTS/STT/TEXT_GENERATION plus the one qualified pre-summary row make five per tenant.
    expect(first).toEqual({ created: 14, skippedExisting: 0, skippedUnresolvable: 0, assignmentsCreated: 10 });
    const system = agents.get(PLATFORM_AGENT_SPECS.find((s) => s.slug === 'general-medicine-summarization')!.id);
    expect(system.compiledConfig.resolvedPrompt).toMatchObject({ source: 'template', promptTemplateId: SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID, promptVersionNumber: 1 });
    expect(system).toMatchObject({ sourceTenantId: SEED_TENANT_ID, sourceSlug: 'general-medicine-summarization', sourceVersionNumber: 1 });
    expect(fallbacks.filter((f) => f.agentId === PLATFORM_AGENT_SPECS.find((s) => s.slug === 'realtime-transcription')!.id)).toHaveLength(2);
    expect(new Set(fallbacks.map((f) => f.id)).size).toBe(fallbacks.length);
    const byTenant = (tenantId: string) => [...assignments.values()].filter((a) => a.tenantId === tenantId);
    expect(byTenant(SYSTEM_TENANT_ID)).toHaveLength(5);
    expect(byTenant(SEED_TENANT_ID)).toHaveLength(5);
    for (const row of assignments.values()) expect(row).toMatchObject({ scope: 'TENANT', scopeId: null });
    // Four unqualified rows per tenant plus the one `phase:pre-summary` row (TASK-932 D-9).
    expect([...assignments.values()].filter((a) => a.selectorKey === '')).toHaveLength(8);
    expect([...assignments.values()].filter((a) => a.selectorKey === 'phase:pre-summary')).toHaveLength(2);

    const second = await seedAgents(client);
    expect(second).toEqual({ created: 0, skippedExisting: 14, skippedUnresolvable: 0, assignmentsCreated: 0 });
  });

  it('fails closed: a missing model or an unapproved template skips the agent and its assignment', async () => {
    const missingNer = fakeClient({ models: Object.keys(REGISTRY).filter((slug) => slug !== 'medical-ner') });
    const result = await seedAgents(missingNer.client);
    expect(result.skippedUnresolvable).toBe(2);
    // 5 declared rows per tenant, minus the NER one whose agent was skipped.
    expect(result.assignmentsCreated).toBe(8);

    const unapproved = fakeClient({ approvedTemplates: false });
    const result2 = await seedAgents(unapproved.client);
    // The FOUR template-bound agents: two summarization + two warm-start (TASK-932 D-9). The DNA
    // analyst is NOT among them — its instruction is INLINE on the agent (D-2), precisely so a
    // tenant is not handed a cloned template it could mistake for the platform's own.
    expect(result2.skippedUnresolvable).toBe(4);
    expect(result2.created).toBe(10);
  });
});
