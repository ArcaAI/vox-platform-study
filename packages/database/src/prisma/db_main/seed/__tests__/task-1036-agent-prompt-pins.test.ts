/**
 * TASK-1036 W3 — every seeded agent PINS every library prompt it binds.
 *
 * A published agent freezes its prompts, and the publish gate refuses a binding that carries no
 * `promptVersionNumber` (`PROMPT_VERSION_UNPINNED`). Wave A left 26 of the 38 seeded agents
 * unpinned on their output-language-policy / same-day-return fragments, with comments arguing that
 * "publish picks the latest". This file pins the opposite, three ways:
 *
 *  1. every template binding (top-level or fragment) of every seeded agent carries a pin;
 *  2. the pin is the version the SEED itself creates for that template — the version row exists
 *     and equals the template's approved version, so a pin can never point at nothing;
 *  3. the contract's own publish gate (`agentConfigProblems`, `phase: 'publish'`) reports no
 *     `PROMPT_VERSION_UNPINNED` for any seeded agent.
 *
 * The contract is imported from SOURCE (this package takes no dependency on it).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCAAI_CLINICAL_APPROVED_VERSION,
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
  ARCAAI_SAME_DAY_RETURN_TEMPLATE,
  ARCAAI_SAME_DAY_RETURN_VERSION,
  ARCAAI_SAME_DAY_RETURN_VERSION_NUMBER,
} from '../07b-arcaai-clinical-templates';
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
  OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
  resolvePromptPublication,
} from '../07-prompt-template';
import { GLOBAL_AGENT_SPECS, GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS, PLATFORM_AGENT_SPECS, type SeedAgentSpec } from '../25-agents';
import { ARCAAI_AGENT_SPECS, ARCAAI_FINALIZATION_AGENT_SPEC } from '../29-arcaai-agents-and-workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { agentConfigProblems } = contract;

interface TemplateRow {
  id: string;
  name: string;
  category: string;
  status?: string;
  currentVersionNumber?: number;
  approvedVersionNumber?: number | null;
}

const TEMPLATES: TemplateRow[] = [
  ...(DEFAULT_PROMPT_TEMPLATES as unknown as TemplateRow[]),
  ...(CUSTOMER_PROMPT_TEMPLATES as unknown as TemplateRow[]),
  ...(GENERAL_MEDICINE_SUMMARY_TEMPLATES as unknown as TemplateRow[]),
  ...(OUTPUT_LANGUAGE_POLICY_TEMPLATES as unknown as TemplateRow[]),
  ...(ARCAAI_CLINICAL_TEMPLATES as unknown as TemplateRow[]),
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE as unknown as TemplateRow,
  ARCAAI_SAME_DAY_RETURN_TEMPLATE as unknown as TemplateRow,
];
const VERSIONS = [
  ...DEFAULT_PROMPT_VERSIONS,
  ...EXTRA_PROMPT_VERSIONS,
  ...CUSTOMER_PROMPT_VERSIONS,
  ...GENERAL_MEDICINE_SUMMARY_VERSIONS,
  ...OUTPUT_LANGUAGE_POLICY_VERSIONS,
  ...ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION,
  ARCAAI_SAME_DAY_RETURN_VERSION,
] as Array<{ promptTemplateId: string; versionNumber: number }>;

/** The 38 catalogue agents (SYSTEM 7 + Global 7 + ArcaAI 23 + the playground-only vLLM spike) plus the ArcaAI finalizer. */
const ALL_AGENTS: SeedAgentSpec[] = [
  ...PLATFORM_AGENT_SPECS,
  ...GLOBAL_AGENT_SPECS,
  ...GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS,
  ...ARCAAI_AGENT_SPECS,
  ARCAAI_FINALIZATION_AGENT_SPEC,
];

interface Binding {
  path: string;
  promptTemplateId: string;
  promptVersionNumber: number | undefined;
}

/** Every library-template binding of an instruction — top-level and per fragment. */
function bindingsOf(spec: SeedAgentSpec): Binding[] {
  const instruction = spec.instruction as Record<string, unknown> | null;
  if (!instruction) return [];
  const out: Binding[] = [];
  if (typeof instruction.promptTemplateId === 'string') {
    out.push({ path: 'instruction', promptTemplateId: instruction.promptTemplateId, promptVersionNumber: instruction.promptVersionNumber as number | undefined });
  }
  if (Array.isArray(instruction.fragments)) {
    (instruction.fragments as Array<Record<string, unknown>>).forEach((fragment, index) => {
      if (typeof fragment.promptTemplateId === 'string') {
        out.push({
          path: `instruction.fragments[${index}] (${String(fragment.key)})`,
          promptTemplateId: fragment.promptTemplateId,
          promptVersionNumber: fragment.promptVersionNumber as number | undefined,
        });
      }
    });
  }
  return out;
}

const label = (spec: SeedAgentSpec) => `${spec.tenantId.slice(0, 8)}/${spec.slug}`;
const BINDING_AGENTS = ALL_AGENTS.filter((spec) => bindingsOf(spec).length > 0);

describe('TASK-1036 W3 — the seeded agent set', () => {
  it('covers every seeded agent: 8 SYSTEM + 8 Global + 1 playground-only + 23 ArcaAI + the ArcaAI finalizer', () => {
    expect(PLATFORM_AGENT_SPECS).toHaveLength(8);
    expect(GLOBAL_AGENT_SPECS).toHaveLength(8);
    expect(GLOBAL_PLAYGROUND_ONLY_AGENT_SPECS).toHaveLength(1);
    expect(ARCAAI_AGENT_SPECS).toHaveLength(23);
    expect(ALL_AGENTS).toHaveLength(41);
  });
});

describe('TASK-1036 W3 — every library prompt a seeded agent binds is pinned', () => {
  it.each(BINDING_AGENTS.map((spec) => [label(spec), spec] as const))('%s: every template binding carries promptVersionNumber', (_label, spec) => {
    const unpinned = bindingsOf(spec).filter((binding) => binding.promptVersionNumber === undefined);
    expect(unpinned.map((binding) => binding.path)).toEqual([]);
  });

  it('the 26 agents that were unpinned before W3 (4 catalogue note writers + 22 ArcaAI summary agents), and the ArcaAI finalizer, carry pins now', () => {
    const withPolicy = ALL_AGENTS.filter((spec) =>
      bindingsOf(spec).some((binding) => [
        ...OUTPUT_LANGUAGE_POLICY_TEMPLATES.map((template) => template.id),
        ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.id,
        ARCAAI_SAME_DAY_RETURN_TEMPLATE.id,
      ].includes(binding.promptTemplateId)),
    );
    // SYSTEM + Global: general-medicine-summarization and casenote-finalization (2 x 2) = 4;
    // ArcaAI: 22 department summary agents + the finalizer = 23.
    expect(withPolicy).toHaveLength(4 + 22 + 1);
    for (const spec of withPolicy) {
      for (const binding of bindingsOf(spec)) expect(binding.promptVersionNumber, `${label(spec)} ${binding.path}`).toBeDefined();
    }
  });

  it.each(BINDING_AGENTS.map((spec) => [label(spec), spec] as const))(
    '%s: each pin is a version the seed creates, and equals the template`s approved version',
    (_label, spec) => {
      for (const binding of bindingsOf(spec)) {
        const template = TEMPLATES.find((row) => row.id === binding.promptTemplateId);
        expect(template, `${binding.path} binds ${binding.promptTemplateId}, which no seed creates`).toBeDefined();
        const approved = resolvePromptPublication(template!).approvedVersionNumber;
        expect(binding.promptVersionNumber, `${binding.path} (${template!.name})`).toBe(approved);
        expect(
          VERSIONS.some((version) => version.promptTemplateId === binding.promptTemplateId && version.versionNumber === binding.promptVersionNumber),
          `${binding.path}: no PromptVersion v${binding.promptVersionNumber} is seeded for ${template!.name}`,
        ).toBe(true);
      }
    },
  );

  it('the policy and same-day pins are the exported version constants of the rows they point at', () => {
    expect(OUTPUT_LANGUAGE_POLICY_TEMPLATES.map((template) => template.approvedVersionNumber)).toEqual([
      OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
      OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER,
    ]);
    expect(ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE.approvedVersionNumber).toBe(ARCAAI_OUTPUT_LANGUAGE_POLICY_VERSION_NUMBER);
    expect(ARCAAI_SAME_DAY_RETURN_TEMPLATE.approvedVersionNumber).toBe(ARCAAI_SAME_DAY_RETURN_VERSION_NUMBER);
    expect(ARCAAI_CLINICAL_APPROVED_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('TASK-1036 W3 — the contract`s publish gate reports no unpinned prompt for any seeded agent', () => {
  it.each(ALL_AGENTS.map((spec) => [label(spec), spec] as const))('%s: no PROMPT_VERSION_UNPINNED at phase=publish', (_label, spec) => {
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
      { phase: 'publish' },
    ) as Array<{ code?: string; path: string }>;
    expect(problems.filter((problem) => problem.code === 'PROMPT_VERSION_UNPINNED')).toEqual([]);
  });

  it('the gate is live: a fragment stripped of its pin IS refused (the check is not vacuous)', () => {
    const problems = agentConfigProblems(
      { task: 'TEXT_GENERATION', instruction: { fragments: [{ key: 'clinical_note', promptTemplateId: 'x' }] } },
      { phase: 'publish' },
    ) as Array<{ code?: string }>;
    expect(problems.some((problem) => problem.code === 'PROMPT_VERSION_UNPINNED')).toBe(true);
  });
});
