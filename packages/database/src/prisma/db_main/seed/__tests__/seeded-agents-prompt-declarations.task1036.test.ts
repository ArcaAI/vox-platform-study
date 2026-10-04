/**
 * TASK-1036 OD-10 — a seeded agent freezes its template's variable DECLARATIONS.
 *
 * Agent publish stores them beside the content in `compiledConfig.resolvedPrompt` (and on each
 * composite fragment), so every lane can render an absent OPTIONAL variable as `""`. A seeded
 * PUBLISHED agent is compiled by `seedAgentSpecs` instead of `AgentService.publish`, and used to
 * leave them out — so a seeded agent's optional variables failed where a published one's rendered
 * empty. This runs every seeded agent spec through the seeder against the REAL seeded template
 * rows and compares each frozen template prompt with the declarations of the row it froze.
 *
 * Hermetic: pure data plus a fake client.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOMER_PROMPT_TEMPLATES,
  CUSTOMER_PROMPT_VERSIONS,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_PROMPT_VERSIONS,
  EXTRA_PROMPT_VERSIONS,
  GENERAL_MEDICINE_SUMMARY_TEMPLATES,
  GENERAL_MEDICINE_SUMMARY_VERSIONS,
  OUTPUT_LANGUAGE_POLICY_TEMPLATES,
  OUTPUT_LANGUAGE_POLICY_VERSIONS,
  resolvePromptPublication,
} from '../07-prompt-template';
import {
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
} from '../07b-arcaai-clinical-templates';
import { SYSTEM_LIVE_SOAP_TEMPLATE, SYSTEM_LIVE_SOAP_VERSION } from '../07c-live-agent-defaults';
import { SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE, SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION } from '../07d-dept-free-pre-summary-default';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS, parseSeedVariableDeclarations, seedAgentSpecs, type SeedAgentsClient } from '../25-agents';
import { ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';

/* eslint-disable @typescript-eslint/no-explicit-any */

const templatesById = new Map<string, any>();
for (const row of [
  ...DEFAULT_PROMPT_TEMPLATES.map((template) => ({ ...template, ...resolvePromptPublication(template) })),
  ...(CUSTOMER_PROMPT_TEMPLATES as any[]),
  ...GENERAL_MEDICINE_SUMMARY_TEMPLATES,
  ...OUTPUT_LANGUAGE_POLICY_TEMPLATES,
  ...ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  SYSTEM_LIVE_SOAP_TEMPLATE,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE,
] as any[])
  templatesById.set(row.id, row);

const versions: any[] = [
  ...DEFAULT_PROMPT_VERSIONS,
  ...EXTRA_PROMPT_VERSIONS,
  ...(CUSTOMER_PROMPT_VERSIONS as any[]),
  ...GENERAL_MEDICINE_SUMMARY_VERSIONS,
  ...OUTPUT_LANGUAGE_POLICY_VERSIONS,
  ...ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
  SYSTEM_LIVE_SOAP_VERSION,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION,
];

function client() {
  const agents = new Map<string, any>();
  const fake = {
    aiModel: {
      findMany: vi.fn(async () => [
        { id: 'm', slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION', provider: 'lm-studio', wireModelId: null },
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
              variables: row.variables ?? null,
            }
          : null;
      }),
    },
    promptVersion: {
      findFirst: vi.fn(async ({ where }: { where: { promptTemplateId: string; versionNumber: number } }) => {
        const row = versions.find((v) => v.promptTemplateId === where.promptTemplateId && v.versionNumber === where.versionNumber);
        return row ? { content: row.content ?? null, variables: row.variables ?? null } : null;
      }),
    },
    agent: { findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: any }) => agents.set(data.id, data)) },
    agentModelFallback: { create: vi.fn() },
    agentAssignment: { findUnique: vi.fn(async () => null), create: vi.fn() },
  };
  return { client: fake as unknown as SeedAgentsClient, agents };
}

/** What the template (version first, as `AgentService` reads it) declares, normalised. */
function expectedDeclarations(templateId: string, versionNumber: number) {
  const version = versions.find((v) => v.promptTemplateId === templateId && v.versionNumber === versionNumber);
  return parseSeedVariableDeclarations(version?.variables ?? templatesById.get(templateId)?.variables);
}

const ALL_SPECS = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC];

describe('seeded agents freeze their template variable declarations (OD-10)', () => {
  it('every template-sourced resolved prompt / fragment carries exactly its template version’s declarations', async () => {
    const { client: fake, agents } = client();
    for (const [index, spec] of ALL_SPECS.entries()) {
      // One list per spec: ids repeat across the SYSTEM and Global lists, and the fake has no uniqueness.
      await seedAgentSpecs(fake, [spec], `spec-${index}`, 1);
    }

    let frozen = 0;
    let declaring = 0;
    for (const row of agents.values()) {
      const resolved = row.compiledConfig?.resolvedPrompt;
      if (!resolved) continue;
      const holders = resolved.source === 'composite' ? resolved.fragments : [resolved];
      for (const holder of holders) {
        if (holder.source !== 'template') continue;
        frozen += 1;
        const expected = expectedDeclarations(holder.promptTemplateId, holder.promptVersionNumber);
        expect(holder.variables ?? [], `${row.slug} ${holder.promptTemplateId}@${holder.promptVersionNumber}`).toEqual(expected);
        if (expected.length > 0) declaring += 1;
      }
    }
    // Not vacuous: templates were frozen, and some of them declare variables.
    expect(frozen).toBeGreaterThan(0);
    expect(declaring).toBeGreaterThan(0);
  });

  it('omits `variables` when the template declares none (an artifact with nothing to say keeps its bytes)', async () => {
    const { client: fake, agents } = client();
    await seedAgentSpecs(fake, ALL_SPECS.slice(0, 1), 'one', 1);
    for (const row of agents.values()) {
      const resolved = row.compiledConfig?.resolvedPrompt;
      if (resolved?.source === 'template' && expectedDeclarations(resolved.promptTemplateId, resolved.promptVersionNumber).length === 0) {
        expect('variables' in resolved).toBe(false);
      }
    }
  });
});
