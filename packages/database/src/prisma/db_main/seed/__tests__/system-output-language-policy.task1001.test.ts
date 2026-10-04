/**
 * TASK-1001 (OD-8) — the output-language policy joins the PLATFORM reference set.
 *
 * Wave 1 seeded the policy as ArcaAI-tenant content only (`07b` + `29`), so every tenant
 * provisioned from SYSTEM got none: its `general-medicine-summarization` body says "write all
 * content values in the conversation language", and on the durable lane nothing overrides that.
 * OD-8 (a): ship the English policy as a SYSTEM reference-set default. Content is CLONED, so this
 * reaches tenants created from here on (and fresh / reset databases), never a running tenant.
 *
 * What this file pins, in the order a reader needs it:
 *  1. the TEMPLATE rows — Global authors, SYSTEM carries the promoted copy (D-8), one text
 *     (the ArcaAI constant, not a second copy), ids that collide with nothing;
 *  2. the AGENTS — exactly the two note-writing agents carry the policy, LAST, PINNED to the seeded
 *     version (TASK-1036 W3), unconditional, pointing at their OWN tenant's row; everything else is deliberately left out;
 *  3. `seedAgentSpecs` compiles the composite — including the INLINE-body fragment
 *     `casenote-finalization` now carries — and fails closed rather than publishing half a prompt;
 *  4. the seed only ever CREATES a published agent (the `agent_immutability_guard` trigger is
 *     absent from the `db push` dev database, so an update would pass locally and raise on the
 *     first cluster reseed);
 *  5. the reference-set copy (phase 26) carries the template and re-points each cloned agent's
 *     policy fragment at the TENANT's clone — and keeps it UNPINNED.
 *
 * Hermetic: pure data, in-memory fakes, no database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY } from '@arcaai/types';

import {
  SEED_TEMPLATE_IDS,
  SEED_TENANT_ID,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION_ID,
  SYSTEM_LIVE_SOAP_TEMPLATE_ID,
  SYSTEM_LIVE_SOAP_VERSION_ID,
  SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  SYSTEM_OUTPUT_LANGUAGE_POLICY_VERSION_ID,
  SYSTEM_TENANT_ID,
} from '../00-constants';
import {
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_PROMPT_VERSIONS,
  EXTRA_PROMPT_VERSIONS,
  GENERAL_MEDICINE_SUMMARY_TEMPLATES,
  GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES,
  GENERAL_MEDICINE_SUMMARY_VERSIONS,
  GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  GLOBAL_OUTPUT_LANGUAGE_POLICY_VERSION_ID,
  OUTPUT_LANGUAGE_POLICY_TEMPLATES,
  OUTPUT_LANGUAGE_POLICY_VERSIONS,
  OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS,
  outputLanguagePolicyFragment,
} from '../07-prompt-template';
import { GOLDEN_PROMPT_TEMPLATES, GOLDEN_PROMPT_VERSIONS } from '../07a-agent-golden-library';
import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
} from '../07b-arcaai-clinical-templates';
import { SYSTEM_LIVE_SOAP_TEMPLATE, SYSTEM_LIVE_SOAP_VERSION } from '../07c-live-agent-defaults';
import { SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE, SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION } from '../07d-dept-free-pre-summary-default';
import {
  CASENOTE_FINALIZATION_SYSTEM_PROMPT,
  CLINICAL_NOTE_FRAGMENT_KEY,
  DNA_WRITING_STYLE_ANALYST_SLUG,
  GLOBAL_AGENT_SPECS,
  OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS,
  PLATFORM_AGENT_SPECS,
  PRE_SUMMARY_AGENT_SLUG,
  buildAgentRow,
  seedAgentSpecs,
  seedAgents,
  type SeedAgentSpec,
  type SeedAgentsClient,
  type SeedResolvedPrompt,
} from '../25-agents';
import { copyAgents, copyPromptTemplates, repointInstructionTemplates } from '../26-tenant-reference-set';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Verbatim, as `output-language-policy.task1001.test.ts` pins it for ArcaAI (finding S-4). */
const HEADINGS_CLAUSE = 'Keep the section keys and headings exactly as given, in English.';
const OVERRIDE_CLAUSE = 'regardless of any instruction elsewhere in this prompt to write content in the conversation language';
const JOIN = '\n\n';

const NEW_TENANT = '5a000000-0000-0000-0000-00000000c0de';
const ARCAAI = '50000000-0000-0000-0000-000000000001';

interface Fragment {
  key: string;
  promptTemplateId?: string;
  promptVersionNumber?: number;
  systemPrompt?: string;
  when?: string;
}

const fragmentsOf = (instruction: unknown): Fragment[] => {
  const fragments = (instruction as { fragments?: unknown } | null)?.fragments;
  return Array.isArray(fragments) ? (fragments as Fragment[]) : [];
};

const specOf = (specs: SeedAgentSpec[], slug: string): SeedAgentSpec => {
  const spec = specs.find((candidate) => candidate.slug === slug);
  if (!spec) throw new Error(`no seeded agent '${slug}'`);
  return spec;
};

const TENANTS = [
  ['SYSTEM', PLATFORM_AGENT_SPECS, SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID],
  ['Global', GLOBAL_AGENT_SPECS, GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY],
] as const;

// =================================================================================================
// 1. The template rows
// =================================================================================================

describe('the platform output-language policy TEMPLATE (Global authors, SYSTEM is the promoted copy)', () => {
  const global = OUTPUT_LANGUAGE_POLICY_TEMPLATES.find((row) => row.tenantId === SEED_TENANT_ID)!;
  const system = OUTPUT_LANGUAGE_POLICY_TEMPLATES.find((row) => row.tenantId === SYSTEM_TENANT_ID)!;

  it('is exactly two rows: one Global, one SYSTEM, under the allocated ids', () => {
    expect(OUTPUT_LANGUAGE_POLICY_TEMPLATES).toHaveLength(2);
    expect(global.id).toBe(GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(system.id).toBe(SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
  });

  it('D-8 provenance: SYSTEM points back at the Global row it was promoted from; Global carries none', () => {
    expect(system.sourceTemplateId).toBe(GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID);
    expect(global.sourceTemplateId).toBeNull();
  });

  it('carries the SAME text as the ArcaAI policy — the one constant, never a second copy', () => {
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) expect(row.content).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT);
    for (const version of OUTPUT_LANGUAGE_POLICY_VERSIONS) expect(version.content).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT);
    // Restated, because these are the two clauses the whole policy exists for (S-4, and the named
    // override that beats the corpus's own "write in the conversation language").
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).toContain(HEADINGS_CLAUSE);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT).toContain(OVERRIDE_CLAUSE);
  });

  it('carries the ArcaAI row`s NAME, so a tenant that already owns a policy is never handed a second row', () => {
    // Phase 26 and `PromptManagementService.cloneFromSystem` both skip a SYSTEM source whose
    // `(tenantId, name)` the target already owns. ArcaAI (and Global) author their own policy row,
    // so a shared name is what keeps them at ONE policy row after provisioning.
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) expect(row.name).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.name);
  });

  it('is APPROVED and pinned at its only version, which is seeded for each tenant', () => {
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) {
      expect(row).toMatchObject({ status: 'APPROVED', approvedVersionNumber: 1, currentVersionNumber: 1 });
    }
    expect(OUTPUT_LANGUAGE_POLICY_VERSIONS.map((version) => [version.id, version.tenantId, version.promptTemplateId, version.versionNumber])).toEqual(
      [
        [GLOBAL_OUTPUT_LANGUAGE_POLICY_VERSION_ID, SEED_TENANT_ID, GLOBAL_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, 1],
        [SYSTEM_OUTPUT_LANGUAGE_POLICY_VERSION_ID, SYSTEM_TENANT_ID, SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, 1],
      ],
    );
  });

  it('is TENANT_DEFAULT with no department — the reference set carries every non-personal SYSTEM row, and a department cannot cross a tenant', () => {
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) {
      expect(row.scope).toBe('TENANT_DEFAULT');
      expect(row.departmentId).toBeNull();
    }
  });

  it('is NOT tagged `pre-summary` (the tag the tenant pre-summary row is found by)', () => {
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) expect(row.tags).not.toContain('pre-summary');
  });

  it('tells the admin what editing it does: a republish, not an instant change; names no code system', () => {
    for (const row of OUTPUT_LANGUAGE_POLICY_TEMPLATES) {
      expect(row.description).toMatch(/republish/i);
      expect(row.description).not.toMatch(/edit THIS row/i);
      expect(row.description).not.toMatch(/ICD-?10/i);
      // The description travels onto every tenant's clone, so it must not name ArcaAI.
      expect(row.description).not.toMatch(/ArcaAI/i);
    }
  });

  it('allocates ids that collide with no other seeded PromptTemplate / PromptVersion id', () => {
    const templateIds = [
      ...Object.values(TEMPLATE_IDS),
      ...Object.values(SEED_TEMPLATE_IDS),
      ...DEFAULT_PROMPT_TEMPLATES.map((row) => row.id),
      ...GENERAL_MEDICINE_SUMMARY_TEMPLATES.map((row) => row.id),
      ...GOLDEN_PROMPT_TEMPLATES.map((row) => row.id),
      ...ARCAAI_CLINICAL_TEMPLATES.map((row) => row.id),
      ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
      SYSTEM_LIVE_SOAP_TEMPLATE_ID,
      SYSTEM_LIVE_SOAP_TEMPLATE.id,
      SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
      SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.id,
    ];
    const versionIds = [
      ...DEFAULT_PROMPT_VERSIONS.map((row) => row.id),
      ...EXTRA_PROMPT_VERSIONS.map((row) => row.id),
      ...GENERAL_MEDICINE_SUMMARY_VERSIONS.map((row) => row.id),
      ...GOLDEN_PROMPT_VERSIONS.map((row) => row.id),
      ...ARCAAI_CLINICAL_VERSIONS.map((row) => row.id),
      ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION.id,
      SYSTEM_LIVE_SOAP_VERSION_ID,
      SYSTEM_LIVE_SOAP_VERSION.id,
      SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION_ID,
      SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION.id,
    ];
    const mine = [...OUTPUT_LANGUAGE_POLICY_TEMPLATES.map((row) => row.id), ...OUTPUT_LANGUAGE_POLICY_VERSIONS.map((row) => row.id)];
    expect(new Set(mine).size).toBe(4);
    for (const id of mine) {
      expect(templateIds, `${id} is already a seeded PromptTemplate id`).not.toContain(id);
      expect(versionIds, `${id} is already a seeded PromptVersion id`).not.toContain(id);
    }
  });
});

// =================================================================================================
// 2. The agents
// =================================================================================================

describe.each(TENANTS)('%s agents', (_label, specs, policyTemplateId, generalMedicineTemplateId) => {
  it('exactly the note-writing agents carry the policy — nothing else does', () => {
    const carrying = specs.filter((spec) => fragmentsOf(spec.instruction).some((fragment) => fragment.key === OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY));
    expect(carrying.map((spec) => spec.slug).sort()).toEqual([...OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS].sort());
    expect([...OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS].sort()).toEqual(['casenote-finalization', 'general-medicine-summarization']);
  });

  it('deliberately leaves out STT, NER, TTS, the warm-start pre-summary and the platform-hidden DNA analyst', () => {
    for (const slug of ['realtime-transcription', 'medical-ner', 'text-to-speech', PRE_SUMMARY_AGENT_SLUG, DNA_WRITING_STYLE_ANALYST_SLUG]) {
      expect(fragmentsOf(specOf(specs, slug).instruction), slug).toEqual([]);
    }
    // The warm start keeps its single template binding, exactly like ArcaAI's: its body carries
    // `{{context.language_name}}`, which the runtime resolves from the platform default.
    expect(specOf(specs, PRE_SUMMARY_AGENT_SLUG).instruction).toHaveProperty('promptTemplateId', TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
  });

  it.each([...OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS])(
    '%s: two fragments, the clinical body then the policy — LAST, pinned, unconditional, its OWN tenant`s row',
    (slug) => {
      const fragments = fragmentsOf(specOf(specs, slug).instruction);
      expect(fragments.map((fragment) => fragment.key)).toEqual([CLINICAL_NOTE_FRAGMENT_KEY, OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY]);
      expect(fragments[1]).toEqual({
        key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
        promptTemplateId: policyTemplateId,
        promptVersionNumber: OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
      });
      expect(fragments[1]).toEqual(outputLanguagePolicyFragment(policyTemplateId));
      // No top-level binding survives beside the composite (the three forms are exclusive, and a
      // top-level pin on a composite is a publish ERROR).
      const instruction = specOf(specs, slug).instruction!;
      expect(instruction).not.toHaveProperty('promptTemplateId');
      expect(instruction).not.toHaveProperty('systemPrompt');
      expect(instruction).not.toHaveProperty('promptVersionNumber');
    },
  );

  it('general-medicine-summarization keeps its template, its pin and EVERY variable binding (F6)', () => {
    const instruction = specOf(specs, 'general-medicine-summarization').instruction as Record<string, any>;
    expect(fragmentsOf(instruction)[0]).toEqual({
      key: CLINICAL_NOTE_FRAGMENT_KEY,
      promptTemplateId: generalMedicineTemplateId,
      promptVersionNumber: 1,
    });
    expect(Object.keys(instruction.variables).sort()).toEqual([...GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES].sort());
  });

  it('casenote-finalization keeps its inline body byte-for-byte, now as an inline FRAGMENT', () => {
    const instruction = specOf(specs, 'casenote-finalization').instruction as Record<string, any>;
    expect(fragmentsOf(instruction)[0]).toEqual({ key: CLINICAL_NOTE_FRAGMENT_KEY, systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT });
    expect(instruction).not.toHaveProperty('variables');
  });
});

// =================================================================================================
// 3 + 4. seedAgentSpecs — the composite compiles, fails closed, and is CREATE-ONLY
// =================================================================================================

const TEMPLATE_ROWS = new Map<
  string,
  { id: string; status: string; content: string; approvedVersionNumber: number | null; currentVersionNumber: number | null }
>(
  [...OUTPUT_LANGUAGE_POLICY_TEMPLATES, ...GENERAL_MEDICINE_SUMMARY_TEMPLATES].map((row) => [
    row.id,
    {
      id: row.id,
      status: row.status,
      content: row.content,
      approvedVersionNumber: row.approvedVersionNumber,
      currentVersionNumber: row.currentVersionNumber,
    },
  ]),
);
const VERSION_ROWS = new Map(
  [...OUTPUT_LANGUAGE_POLICY_VERSIONS, ...GENERAL_MEDICINE_SUMMARY_VERSIONS].map((row) => [
    `${row.promptTemplateId}@${row.versionNumber}`,
    row.content,
  ]),
);

const MODELS = [
  ['arcaai-whisper-large-ml-en-gguf', 'AUTOMATIC_SPEECH_RECOGNITION'],
  ['arcaai-whisper-large-ml-en-gguf-q8_0', 'AUTOMATIC_SPEECH_RECOGNITION'],
  ['faster-whisper-large-v3-turbo-int8', 'AUTOMATIC_SPEECH_RECOGNITION'],
  ['medical-ner', 'TOKEN_CLASSIFICATION'],
  ['lms-gemma-4-e2b-it-qat', 'TEXT_GENERATION'],
  ['kokoro', 'TEXT_TO_SPEECH'],
].map(([slug, taskType]) => ({ id: `model-${slug}`, slug: slug!, taskType: taskType!, provider: 'built-in', wireModelId: null }));

function seedClient(options: { policyStatus?: string; existing?: Map<string, Record<string, unknown>> } = {}) {
  const agents = options.existing ?? new Map<string, Record<string, unknown>>();
  // `update` / `upsert` are NOT part of `SeedAgentsClient`; they are here only so a test can prove
  // nothing reaches for them.
  const agent = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (agents.has(where.id) ? { id: where.id } : null)),
    create: vi.fn(async ({ data }: { data: unknown }) => {
      agents.set((data as { id: string }).id, data as Record<string, unknown>);
      return data;
    }),
    update: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  };
  const client = {
    aiModel: { findMany: vi.fn(async () => MODELS) },
    promptTemplate: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = TEMPLATE_ROWS.get(where.id);
        if (!row) return { id: where.id, status: 'APPROVED', content: `body of ${where.id}`, approvedVersionNumber: 1, currentVersionNumber: 1 };
        const isPolicy = OUTPUT_LANGUAGE_POLICY_TEMPLATES.some((policy) => policy.id === where.id);
        return isPolicy && options.policyStatus ? { ...row, status: options.policyStatus } : row;
      }),
    },
    promptVersion: {
      findFirst: vi.fn(async ({ where }: { where: { promptTemplateId: string; versionNumber: number } }) => ({
        content: VERSION_ROWS.get(`${where.promptTemplateId}@${where.versionNumber}`) ?? `v${where.versionNumber} of ${where.promptTemplateId}`,
      })),
    },
    agent,
    agentModelFallback: { create: vi.fn(async () => undefined) },
    agentAssignment: { findUnique: vi.fn(async () => null), create: vi.fn(async () => undefined) },
  };
  return { client: client as unknown as SeedAgentsClient, agents, agent };
}

describe('seedAgentSpecs compiles the composite exactly as AgentService.resolveCompositePrompt does', () => {
  it.each(TENANTS)(
    '%s casenote-finalization: the INLINE fragment resolves through the composite branch beside the template one',
    async (_label, specs, policyTemplateId) => {
      const spec = specOf(specs, 'casenote-finalization');
      const { client, agents } = seedClient();
      expect(await seedAgentSpecs(client, [spec], 'test', 1)).toMatchObject({ created: 1, skippedUnresolvable: 0 });

      const resolved = (agents.get(spec.id)!.compiledConfig as { resolvedPrompt: SeedResolvedPrompt }).resolvedPrompt;
      expect(resolved).toEqual({
        source: 'composite',
        // The STATIC PROJECTION: both fragments are unconditional, joined in authored order.
        content: `${CASENOTE_FINALIZATION_SYSTEM_PROMPT}${JOIN}${ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT}`,
        join: JOIN,
        fragments: [
          { key: CLINICAL_NOTE_FRAGMENT_KEY, source: 'inline', content: CASENOTE_FINALIZATION_SYSTEM_PROMPT, when: null },
          {
            key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
            source: 'template',
            promptTemplateId: policyTemplateId,
            // UNPINNED on the instruction, so publish resolves the template's own approved version.
            promptVersionNumber: 1,
            content: ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT,
            when: null,
          },
        ],
      });
      // The policy text is the LAST thing in the compiled prompt — nearest the generation point.
      expect((resolved as { content: string }).content.endsWith(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT)).toBe(true);
    },
  );

  it.each(TENANTS)(
    '%s general-medicine-summarization: the tenant`s own template, then its own policy',
    async (_label, specs, policyTemplateId, generalMedicineTemplateId) => {
      const spec = specOf(specs, 'general-medicine-summarization');
      const { client, agents } = seedClient();
      await seedAgentSpecs(client, [spec], 'test', 1);

      const resolved = (agents.get(spec.id)!.compiledConfig as { resolvedPrompt: any }).resolvedPrompt;
      expect(resolved.source).toBe('composite');
      expect(
        resolved.fragments.map((fragment: any) => [fragment.key, fragment.source, fragment.promptTemplateId, fragment.promptVersionNumber]),
      ).toEqual([
        [CLINICAL_NOTE_FRAGMENT_KEY, 'template', generalMedicineTemplateId, 1],
        [OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, 'template', policyTemplateId, 1],
      ]);
      expect(resolved.content.endsWith(ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT)).toBe(true);
    },
  );

  it('fails CLOSED when the policy template is not APPROVED — neither note agent is published with half a prompt', async () => {
    const { client, agents } = seedClient({ policyStatus: 'DRAFT' });
    const result = await seedAgents(client);
    // 2 note-writing agents × 2 tenants skipped; the other ten are unaffected.
    expect(result).toMatchObject({ created: 10, skippedUnresolvable: 4 });
    for (const slug of OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS) {
      expect(agents.has(specOf(PLATFORM_AGENT_SPECS, slug).id), slug).toBe(false);
      expect(agents.has(specOf(GLOBAL_AGENT_SPECS, slug).id), slug).toBe(false);
    }
  });
});

describe('the seed only ever CREATES a published agent (agent_immutability_guard, task_863)', () => {
  it('a fresh database: every agent goes through `create`, nothing through update/upsert', async () => {
    const { client, agent } = seedClient();
    expect(await seedAgents(client)).toMatchObject({ created: 14, skippedExisting: 0, skippedUnresolvable: 0 });
    expect(agent.create).toHaveBeenCalledTimes(14);
    expect(agent.update).not.toHaveBeenCalled();
    expect(agent.upsert).not.toHaveBeenCalled();
    expect(agent.updateMany).not.toHaveBeenCalled();
  });

  it('an ALREADY-SEEDED database (the cluster): the rows published BEFORE this change are skipped by id and left byte-identical', async () => {
    // What a running database holds today: the same ids, PUBLISHED, on the OLD single-body forms.
    const existing = new Map<string, Record<string, unknown>>();
    for (const spec of [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS]) {
      const old =
        spec.slug === 'casenote-finalization'
          ? { systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT }
          : spec.slug === 'general-medicine-summarization'
            ? { promptTemplateId: fragmentsOf(spec.instruction)[0]!.promptTemplateId, promptVersionNumber: 1 }
            : spec.instruction;
      existing.set(spec.id, { id: spec.id, status: 'PUBLISHED', instruction: old });
    }
    const before = structuredClone(Object.fromEntries(existing));

    const { client, agent } = seedClient({ existing });
    expect(await seedAgents(client)).toMatchObject({ created: 0, skippedExisting: 14 });
    expect(agent.create).not.toHaveBeenCalled();
    expect(agent.update).not.toHaveBeenCalled();
    expect(agent.upsert).not.toHaveBeenCalled();
    expect(agent.updateMany).not.toHaveBeenCalled();
    expect(Object.fromEntries(existing)).toEqual(before);
  });

  it('structurally: 25-agents.ts never calls an agent update / upsert, and the client slice it declares has none', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(HERE, '../25-agents.ts'), 'utf8');
    expect(source).not.toMatch(/\bagent\.(update|upsert|updateMany)\s*\(/);
    const clientSlice = source.slice(
      source.indexOf('export interface SeedAgentsClient'),
      source.indexOf('agentModelFallback:', source.indexOf('export interface SeedAgentsClient')),
    );
    expect(clientSlice).toContain('create(args');
    expect(clientSlice).not.toMatch(/\b(update|upsert|updateMany)\s*\(/);
  });
});

// =================================================================================================
// 5. The reference set (phase 26) — the twin of TenantReferenceSetService
// =================================================================================================

interface Row extends Record<string, unknown> {
  id: string;
  tenantId: string;
}

/** An in-memory slice of the four tables phase 26 touches, matching `where` by equality and `{ not }`. */
function referenceSetClient() {
  const tables = { promptTemplate: [] as Row[], promptVersion: [] as Row[], agent: [] as Row[] };
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, expected]) => {
      const actual = row[field] ?? (field === 'resourceStatus' ? 'ENABLED' : undefined);
      if (expected !== null && typeof expected === 'object' && 'not' in (expected as object)) return actual !== (expected as { not: unknown }).not;
      return actual === expected;
    });
  const table = (name: keyof typeof tables) => ({
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => tables[name].filter((row) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => tables[name].find((row) => matches(row, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      tables[name].push(data);
      return data;
    }),
  });
  const client = {
    promptTemplate: table('promptTemplate'),
    promptVersion: table('promptVersion'),
    agent: table('agent'),
    agentModelFallback: { findMany: vi.fn(async () => []), create: vi.fn() },
  };
  return { tables, client: client as never };
}

/** The SYSTEM reference set as a fresh seed leaves it: the two templates, their versions, the two note agents. */
function withSystemReferenceSet(tables: ReturnType<typeof referenceSetClient>['tables']) {
  const system = <T extends { tenantId: string }>(rows: readonly T[]) => rows.filter((row) => row.tenantId === SYSTEM_TENANT_ID);
  tables.promptTemplate.push(
    ...(system(GENERAL_MEDICINE_SUMMARY_TEMPLATES) as unknown as Row[]),
    ...(system(OUTPUT_LANGUAGE_POLICY_TEMPLATES) as unknown as Row[]),
  );
  tables.promptVersion.push(
    ...(system(GENERAL_MEDICINE_SUMMARY_VERSIONS) as unknown as Row[]),
    ...(system(OUTPUT_LANGUAGE_POLICY_VERSIONS) as unknown as Row[]),
  );
  for (const slug of OUTPUT_LANGUAGE_POLICY_AGENT_SLUGS) {
    const spec = specOf(PLATFORM_AGENT_SPECS, slug);
    const row = buildAgentRow(
      spec,
      { id: 'model-gemma', slug: spec.modelSlug, taskType: 'TEXT_GENERATION', provider: 'lm-studio', wireModelId: null },
      [],
      null,
    );
    tables.agent.push({ ...row, resourceStatus: 'ENABLED' } as unknown as Row);
  }
}

describe('phase 26 carries the policy into a NEW tenant and re-points the cloned agents at it', () => {
  it('the policy template is cloned with provenance, APPROVED at the clone`s own v1', async () => {
    const { tables, client } = referenceSetClient();
    withSystemReferenceSet(tables);

    expect(await copyPromptTemplates(client, NEW_TENANT)).toBe(2);
    const clone = tables.promptTemplate.find(
      (row) => row.tenantId === NEW_TENANT && row.sourceTemplateId === SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
    )!;
    expect(clone).toMatchObject({
      name: ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.name,
      content: ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT,
      status: 'APPROVED',
      approvedVersionNumber: 1,
      currentVersionNumber: 1,
      scope: 'TENANT_DEFAULT',
      templateLocked: true,
    });
    expect(tables.promptVersion.filter((row) => row.promptTemplateId === clone.id)).toEqual([
      expect.objectContaining({ tenantId: NEW_TENANT, versionNumber: 1, content: ARCAAI_OUTPUT_LANGUAGE_POLICY_CONTENT }),
    ]);
  });

  it('both cloned note agents point at the TENANT`s ONE policy row — and the fragment pin is translated to the clone`s own v1', async () => {
    const { tables, client } = referenceSetClient();
    withSystemReferenceSet(tables);
    await copyPromptTemplates(client, NEW_TENANT);
    expect(await copyAgents(client, NEW_TENANT)).toBe(2);

    const policyRows = tables.promptTemplate.filter((row) => row.tenantId === NEW_TENANT && row.name === ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.name);
    expect(policyRows).toHaveLength(1);
    const policyClone = policyRows[0]!;
    const gmClone = tables.promptTemplate.find(
      (row) => row.tenantId === NEW_TENANT && row.sourceTemplateId === SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
    )!;

    const cloned = (slug: string) => tables.agent.find((row) => row.tenantId === NEW_TENANT && row.slug === slug)!;
    expect(fragmentsOf(cloned('general-medicine-summarization').instruction)).toEqual([
      // A SOURCE pin is translated to the clone's own lineage (it restarts at 1)…
      { key: CLINICAL_NOTE_FRAGMENT_KEY, promptTemplateId: gmClone.id, promptVersionNumber: 1 },
      // …and so is the policy pin (TASK-1036 W3: a published agent pins every prompt it binds).
      // The tenant's policy lineage restarts at 1, so the pin is the clone's approved version; the
      // admin's later approved edit reaches a note when the agent is republished against it.
      { key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, promptTemplateId: policyClone.id, promptVersionNumber: policyClone.approvedVersionNumber },
    ]);
    expect(fragmentsOf(cloned('casenote-finalization').instruction)).toEqual([
      { key: CLINICAL_NOTE_FRAGMENT_KEY, systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT },
      { key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, promptTemplateId: policyClone.id, promptVersionNumber: policyClone.approvedVersionNumber },
    ]);
    // The variable bindings travel with the composite.
    expect(Object.keys((cloned('general-medicine-summarization').instruction as any).variables).sort()).toEqual(
      [...GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES].sort(),
    );
  });

  it('a tenant that already OWNS a policy (ArcaAI) keeps exactly one policy row; the SYSTEM binding then travels verbatim', async () => {
    const { tables, client } = referenceSetClient();
    withSystemReferenceSet(tables);
    tables.promptTemplate.push({ ...(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE as unknown as Row), tenantId: ARCAAI, sourceTemplateId: null });

    await copyPromptTemplates(client, ARCAAI);
    await copyAgents(client, ARCAAI);

    expect(tables.promptTemplate.filter((row) => row.tenantId === ARCAAI && row.name === ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.name)).toHaveLength(
      1,
    );
    // No provenance clone exists, so — exactly as `AgentService.referenceInstruction` does — the
    // binding keeps the SYSTEM id (publish names it in its findings). The compiled artifact still
    // carries the same frozen text.
    const finalization = tables.agent.find((row) => row.tenantId === ARCAAI && row.slug === 'casenote-finalization')!;
    expect(fragmentsOf(finalization.instruction)[1]).toEqual({
      key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
      promptTemplateId: SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
      promptVersionNumber: OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
    });
  });

  it('repointInstructionTemplates: a pin is translated to the clone`s version', () => {
    const clones = new Map([
      [SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID, { id: 'gm-clone', approvedVersionNumber: 1 }],
      [SYSTEM_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID, { id: 'policy-clone', approvedVersionNumber: 1 }],
    ]);
    const instruction = specOf(PLATFORM_AGENT_SPECS, 'general-medicine-summarization').instruction;
    expect(fragmentsOf(repointInstructionTemplates(instruction, clones))).toEqual([
      { key: CLINICAL_NOTE_FRAGMENT_KEY, promptTemplateId: 'gm-clone', promptVersionNumber: 1 },
      { key: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, promptTemplateId: 'policy-clone', promptVersionNumber: 1 },
    ]);
  });
});
