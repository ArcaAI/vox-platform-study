/**
 * TASK-1001 — no two seeded prompt rows may share an id.
 *
 * Every prompt seeder writes by `upsert` on the row id, so two literals that name the same id do
 * not fail — the LATER phase silently overwrites the earlier row. That is exactly what shipped in
 * TASK-930: `SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID` was declared on `…-0004-000000000002`,
 * the slot `00-constants.ts` had already reserved for the department-free pre-summary, and
 * `seedDeptFreePreSummaryDefault` runs after `seedPromptTemplate`. On every fresh database the row
 * (and its v1 version) held the PRE-SUMMARY body, so the PUBLISHED SYSTEM `general-medicine-
 * summarization` agent — and every tenant's clone of it — froze "## Medical AI Pre-Summary Prompt"
 * as its running-note instruction. Confirmed on the local dev database, 2026-09-23.
 *
 * Nothing noticed because each seeder's own suite looks only at its own rows. This one looks at
 * ALL of them, and at the seed files, so a new writer cannot slip past it unlisted.
 *
 * Hermetic: pure data plus the seed sources read as text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID, SYSTEM_GENERAL_MEDICINE_SUMMARY_VERSION_ID, SYSTEM_TENANT_ID } from '../00-constants';
import {
  CUSTOMER_PROMPT_TEMPLATES,
  CUSTOMER_PROMPT_VERSIONS,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_PROMPT_VERSIONS,
  EXTRA_PROMPT_VERSIONS,
  GENERAL_MEDICINE_SUMMARY_CONTENT,
  GENERAL_MEDICINE_SUMMARY_TEMPLATES,
  GENERAL_MEDICINE_SUMMARY_VERSIONS,
  OUTPUT_LANGUAGE_POLICY_TEMPLATES,
  OUTPUT_LANGUAGE_POLICY_VERSIONS,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  resolvePromptPublication,
} from '../07-prompt-template';
import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
} from '../07b-arcaai-clinical-templates';
import { SYSTEM_LIVE_SOAP_TEMPLATE, SYSTEM_LIVE_SOAP_VERSION } from '../07c-live-agent-defaults';
import {
  SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION,
} from '../07d-dept-free-pre-summary-default';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS, seedAgentSpecs, type SeedAgentsClient } from '../25-agents';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '..');

interface TemplateRow {
  id: string;
  tenantId: string;
  name: string | null;
  status?: string | null;
  content?: string | null;
  category?: string;
  approvedVersionNumber?: number | null;
  currentVersionNumber?: number | null;
}
interface VersionRow {
  id: string;
  promptTemplateId: string;
  versionNumber: number;
  content?: string | null;
}

/**
 * Every static PromptTemplate row a seed phase WRITES, grouped by writer, IN SEED ORDER (`index.ts`:
 * 07 → 07b → 07c → 07d). Phase 26 writes clones too, but their ids are DERIVED from
 * `(tenantId, sourceId)` (`cloneId`), so they have no literal to collide.
 */
const WRITTEN_TEMPLATES: ReadonlyArray<readonly [string, ReadonlyArray<TemplateRow>]> = [
  [
    '07-prompt-template DEFAULT_PROMPT_TEMPLATES',
    DEFAULT_PROMPT_TEMPLATES.map((row) => ({ ...row, ...resolvePromptPublication(row) })) as TemplateRow[],
  ],
  ['07-prompt-template CUSTOMER_PROMPT_TEMPLATES', CUSTOMER_PROMPT_TEMPLATES as unknown as TemplateRow[]],
  ['07-prompt-template GENERAL_MEDICINE_SUMMARY_TEMPLATES', GENERAL_MEDICINE_SUMMARY_TEMPLATES],
  ['07-prompt-template OUTPUT_LANGUAGE_POLICY_TEMPLATES', OUTPUT_LANGUAGE_POLICY_TEMPLATES],
  ['07b ARCAAI_CLINICAL_TEMPLATES', ARCAAI_CLINICAL_TEMPLATES],
  ['07b ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE', [ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE]],
  ['07c SYSTEM_LIVE_SOAP_TEMPLATE', [SYSTEM_LIVE_SOAP_TEMPLATE as unknown as TemplateRow]],
  ['07d SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE', [SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE as unknown as TemplateRow]],
];

/** Every static PromptVersion row a seed phase writes, in the same order. */
const WRITTEN_VERSIONS: ReadonlyArray<readonly [string, ReadonlyArray<VersionRow>]> = [
  ['07-prompt-template DEFAULT_PROMPT_VERSIONS', DEFAULT_PROMPT_VERSIONS],
  ['07-prompt-template EXTRA_PROMPT_VERSIONS', EXTRA_PROMPT_VERSIONS],
  ['07-prompt-template CUSTOMER_PROMPT_VERSIONS', CUSTOMER_PROMPT_VERSIONS as unknown as VersionRow[]],
  ['07-prompt-template GENERAL_MEDICINE_SUMMARY_VERSIONS', GENERAL_MEDICINE_SUMMARY_VERSIONS],
  ['07-prompt-template OUTPUT_LANGUAGE_POLICY_VERSIONS', OUTPUT_LANGUAGE_POLICY_VERSIONS],
  ['07b ARCAAI_CLINICAL_VERSIONS', ARCAAI_CLINICAL_VERSIONS],
  ['07b ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION', [ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION]],
  ['07c SYSTEM_LIVE_SOAP_VERSION', [SYSTEM_LIVE_SOAP_VERSION as unknown as VersionRow]],
  ['07d SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION', [SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION as unknown as VersionRow]],
];

/** The seed files that write PromptTemplate / PromptVersion rows — the writers enrolled above, plus phase 26's derived-id clones. */
const PROMPT_WRITER_FILES = [
  '07-prompt-template.ts',
  '07b-arcaai-clinical-templates.ts',
  '07c-live-agent-defaults.ts',
  '07d-dept-free-pre-summary-default.ts',
  '26-tenant-reference-set.ts',
];

/** `id → the writers that name it`, only for ids named more than once. */
function duplicates<T extends { id: string }>(
  writers: ReadonlyArray<readonly [string, ReadonlyArray<T>]>,
  keyOf: (row: T) => string = (row) => row.id,
) {
  const owners = new Map<string, string[]>();
  for (const [writer, rows] of writers) {
    for (const row of rows) owners.set(keyOf(row), [...(owners.get(keyOf(row)) ?? []), writer]);
  }
  return Object.fromEntries([...owners].filter(([, names]) => names.length > 1));
}

describe('seeded prompt rows — one row per id', () => {
  it('no two seeded PromptTemplate rows share an id (an upsert would silently let the later one win)', () => {
    expect(duplicates(WRITTEN_TEMPLATES)).toEqual({});
  });

  it('no two seeded PromptVersion rows share an id', () => {
    expect(duplicates(WRITTEN_VERSIONS)).toEqual({});
  });

  it('no id is used as BOTH a template and a version id', () => {
    const templateIds = new Set(WRITTEN_TEMPLATES.flatMap(([, rows]) => rows.map((row) => row.id)));
    expect(WRITTEN_VERSIONS.flatMap(([, rows]) => rows.map((row) => row.id)).filter((id) => templateIds.has(id))).toEqual([]);
  });

  it('no two versions claim the same (promptTemplateId, versionNumber) — `@@unique` on PromptVersion', () => {
    expect(duplicates(WRITTEN_VERSIONS, (row) => `${row.promptTemplateId}@${row.versionNumber}`)).toEqual({});
  });

  it('no two templates claim the same (tenantId, name) — `@@unique` on PromptTemplate', () => {
    expect(duplicates(WRITTEN_TEMPLATES, (row) => `${row.tenantId}::${row.name}`)).toEqual({});
  });

  it('every seed file that writes prompt rows is enrolled in this guard', () => {
    const writes = /\bprompt(?:Template|Version)\.(?:upsert|create|createMany|update|updateMany)\s*\(/;
    const writers = readdirSync(SEED_DIR)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => writes.test(readFileSync(path.join(SEED_DIR, file), 'utf8')))
      .sort();
    expect(writers, 'a new prompt writer must add its rows to WRITTEN_TEMPLATES / WRITTEN_VERSIONS above').toEqual([...PROMPT_WRITER_FILES].sort());
  });

  it('the enrolment ORDER is the order index.ts runs the writers in (it decides who a collision would have let win)', () => {
    const index = readFileSync(path.join(SEED_DIR, 'index.ts'), 'utf8');
    const positions = ['seedPromptTemplate(', 'seedArcaaiClinicalTemplates(', 'seedLiveAgentDefaults(', 'seedDeptFreePreSummaryDefault('].map(
      (call) => index.indexOf(`await ${call}`),
    );
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// =================================================================================================
// The regression, reproduced: seed phase 3 in order, LAST WRITE WINS (as the upserts do), then
// compile the SYSTEM agent against what the database would actually hold.
// =================================================================================================

const templatesById = new Map<string, TemplateRow>();
for (const [, rows] of WRITTEN_TEMPLATES) for (const row of rows) templatesById.set(row.id, row);
const versionsById = new Map<string, VersionRow>();
for (const [, rows] of WRITTEN_VERSIONS) for (const row of rows) versionsById.set(row.id, row);

function phaseThreeClient() {
  const agents = new Map<string, any>();
  const client = {
    aiModel: {
      findMany: vi.fn(async () => [
        { id: 'model-gemma', slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION', provider: 'lm-studio', wireModelId: null },
      ]),
    },
    promptTemplate: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = templatesById.get(where.id);
        return row
          ? {
              id: row.id,
              status: row.status ?? null,
              content: row.content ?? null,
              approvedVersionNumber: row.approvedVersionNumber ?? null,
              currentVersionNumber: row.currentVersionNumber ?? null,
            }
          : null;
      }),
    },
    promptVersion: {
      findFirst: vi.fn(async ({ where }: { where: { promptTemplateId: string; versionNumber: number } }) => {
        const version = [...versionsById.values()].find(
          (row) => row.promptTemplateId === where.promptTemplateId && row.versionNumber === where.versionNumber,
        );
        return version ? { content: version.content ?? null } : null;
      }),
    },
    agent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: any }) => agents.set(data.id, data)),
    },
    agentModelFallback: { create: vi.fn() },
    agentAssignment: { findUnique: vi.fn(), create: vi.fn() },
  };
  return { client: client as unknown as SeedAgentsClient, agents };
}

describe('the SYSTEM general-medicine-summarization agent freezes the General Medicine text', () => {
  it('the SYSTEM General Medicine rows sit on their own slot, not the department-free pre-summary`s', () => {
    expect(SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID).not.toBe(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID);
    expect(templatesById.get(SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID)).toMatchObject({
      tenantId: SYSTEM_TENANT_ID,
      content: GENERAL_MEDICINE_SUMMARY_CONTENT,
    });
    expect(versionsById.get(SYSTEM_GENERAL_MEDICINE_SUMMARY_VERSION_ID)).toMatchObject({
      promptTemplateId: SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
      content: GENERAL_MEDICINE_SUMMARY_CONTENT,
    });
    // …and the pre-summary keeps its own row, which `SYSTEM_DEFAULTS.deptFreePreSummaryPromptId` names.
    expect(templatesById.get(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID)?.content).toBe(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT);
  });

  it.each([
    ['SYSTEM', PLATFORM_AGENT_SPECS],
    ['Global', GLOBAL_AGENT_SPECS],
  ] as const)('%s: the compiled clinical_note fragment IS the General Medicine body, never the pre-summary', async (_label, specs) => {
    const spec = specs.find((candidate) => candidate.slug === 'general-medicine-summarization')!;
    const { client, agents } = phaseThreeClient();
    expect(await seedAgentSpecs(client, [spec], 'test', 1)).toMatchObject({ created: 1, skippedUnresolvable: 0 });

    const resolved = agents.get(spec.id).compiledConfig.resolvedPrompt;
    expect(resolved.fragments[0]).toMatchObject({ key: 'clinical_note', source: 'template', content: GENERAL_MEDICINE_SUMMARY_CONTENT });
    expect(resolved.content.startsWith(GENERAL_MEDICINE_SUMMARY_CONTENT)).toBe(true);
    expect(resolved.content).not.toContain(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT);
  });
});
