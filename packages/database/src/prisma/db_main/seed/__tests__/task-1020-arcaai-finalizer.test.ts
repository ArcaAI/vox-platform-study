/**
 * TASK-1020 live-replay defect D2 — the durable finalizer never saw the same-day prequel or the
 * results.
 *
 * Every ArcaAI consultation graph finalizes on `n_finalize` → `casenote-finalization`. The tenant
 * used to get that agent as a verbatim CLONE of the SYSTEM row (phase 26), whose instruction is the
 * finalization body plus the output-language policy — nothing that reads
 * `trigger.context.same_day_prequel_summary` / `formatted_test_results`. So an afternoon return's
 * finalized note was built from the partial note alone: the lab values were lost and the plan
 * sections came out empty.
 *
 * ArcaAI now seeds its OWN `casenote-finalization` in phase 29 (the precedent is its own warm start:
 * phase 29 runs before 26, and `copyAgents` skips a slug the tenant already has). It carries the
 * SAME `same_day_return` fragment the 11 revisit agents carry, with the same guarded `when`,
 * between the finalization body (first) and the language policy (last).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import { DEFAULT_AI_MODELS } from '../06-ai-models';
import {
  ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
  ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID,
  ARCAAI_SAME_DAY_RETURN_CONTENT,
  ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY,
  ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID,
  ARCAAI_SAME_DAY_RETURN_WHEN,
} from '../07b-arcaai-clinical-templates';
import {
  CASENOTE_FINALIZATION_SYSTEM_PROMPT,
  CASENOTE_OUTPUT_SCHEMA,
  CLINICAL_NOTE_FRAGMENT_KEY,
  GLOBAL_AGENT_SPECS,
  PLATFORM_AGENT_SPECS,
} from '../25-agents';
import {
  ARCAAI_AGENT_SPECS,
  ARCAAI_FINALIZATION_AGENT_SPEC,
  ARCAAI_WORKFLOW_TARGETS,
  seedArcaaiAgentsAndWorkflows,
} from '../29-arcaai-agents-and-workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

interface Fragment {
  key: string;
  promptTemplateId?: string;
  promptVersionNumber?: number;
  systemPrompt?: string;
  when?: string;
}
const fragments = (): Fragment[] => (ARCAAI_FINALIZATION_AGENT_SPEC.instruction as { fragments: Fragment[] }).fragments;

describe('ArcaAI `casenote-finalization` — the agent `n_finalize` runs', () => {
  it('is the agent every ArcaAI consultation graph finalizes on', () => {
    expect(ARCAAI_WORKFLOW_TARGETS).toHaveLength(11);
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      const finalize = target.graph.nodes.find((node) => node.id === 'n_finalize');
      expect((finalize?.config as { agentRef?: { slug?: string } }).agentRef?.slug, target.slug).toBe(ARCAAI_FINALIZATION_AGENT_SPEC.slug);
    }
  });

  it('is ArcaAI-owned, same slug, model, parameters and output contract as the platform finalizer', () => {
    const platform = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === 'casenote-finalization')!;
    expect(ARCAAI_FINALIZATION_AGENT_SPEC).toMatchObject({
      tenantId: ARCAAI,
      slug: 'casenote-finalization',
      task: 'TEXT_GENERATION',
      status: 'PUBLISHED',
      isActive: true,
      provenance: null,
      modelSlug: platform.modelSlug,
      fallbackModelSlugs: platform.fallbackModelSlugs,
    });
    expect(ARCAAI_FINALIZATION_AGENT_SPEC.parameters).toEqual(platform.parameters);
    expect(ARCAAI_FINALIZATION_AGENT_SPEC.outputSchema).toEqual(CASENOTE_OUTPUT_SCHEMA);
  });

  it('composes the finalization body FIRST, then same_day_return (conditional, unpinned), then the language policy LAST', () => {
    expect(fragments().map((fragment) => fragment.key)).toEqual([
      CLINICAL_NOTE_FRAGMENT_KEY,
      ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY,
      ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
    ]);
    const [base, sameDay, policy] = fragments();
    expect(base).toEqual({ key: CLINICAL_NOTE_FRAGMENT_KEY, systemPrompt: CASENOTE_FINALIZATION_SYSTEM_PROMPT });
    expect(sameDay).toEqual({
      key: ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY,
      promptTemplateId: ARCAAI_SAME_DAY_RETURN_TEMPLATE_ID,
      when: ARCAAI_SAME_DAY_RETURN_WHEN,
    });
    expect(policy).toEqual({ key: ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, promptTemplateId: ARCAAI_OUTPUT_LANGUAGE_POLICY_TEMPLATE_ID });
  });

  it('has an id no other seeded agent uses', () => {
    const others = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS].map((spec) => spec.id);
    expect(others).not.toContain(ARCAAI_FINALIZATION_AGENT_SPEC.id);
  });

  it('passes the publish gate with the bound model`s capabilities (no ERROR)', () => {
    const model = DEFAULT_AI_MODELS.find((row) => row.slug === ARCAAI_FINALIZATION_AGENT_SPEC.modelSlug)!;
    const meta = (model.metaData ?? {}) as Record<string, any>;
    const caps = meta.capabilities ?? meta;
    const problems = contract.agentConfigProblems(
      {
        task: ARCAAI_FINALIZATION_AGENT_SPEC.task,
        instruction: ARCAAI_FINALIZATION_AGENT_SPEC.instruction,
        parameters: ARCAAI_FINALIZATION_AGENT_SPEC.parameters,
        inputSchema: null,
        outputSchema: ARCAAI_FINALIZATION_AGENT_SPEC.outputSchema,
        tools: null,
        contextSchemaId: null,
        contextSchemaVersionNumber: null,
      },
      {
        model: { slug: model.slug, taskType: String(model.taskType), provider: model.provider ?? undefined },
        fallbackModels: [],
        capabilities: { supportedGenerationParams: caps.supportedGenerationParams, label: `${model.provider}/${model.slug}` },
      },
    );
    expect(
      problems.filter((problem: { severity: string }) => problem.severity === 'ERROR'),
      JSON.stringify(problems),
    ).toEqual([]);
  });

  /** The durable scope, built as `workflow.py#_publish_context` builds it from a handoff context. */
  const durableScope = (live: Record<string, unknown>) => {
    const trigger = { ...live, context: { ...live } };
    return { trigger, context: trigger, vars: {}, nodes: {}, variables: {} };
  };
  const composite = () => ({
    source: 'composite',
    fragments: [
      { key: CLINICAL_NOTE_FRAGMENT_KEY, source: 'inline', content: CASENOTE_FINALIZATION_SYSTEM_PROMPT },
      { key: ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY, source: 'template', content: ARCAAI_SAME_DAY_RETURN_CONTENT, when: ARCAAI_SAME_DAY_RETURN_WHEN },
      { key: ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY, source: 'template', content: 'POLICY' },
    ],
  });

  it('on a same-day return the finalize prompt carries the prequel AND the results', () => {
    const composed = contract.composePrompt(
      composite(),
      durableScope({
        visit_type: 'revisit',
        same_day_prequel: true,
        same_day_prequel_summary: 'MORNING NOTE: aspirin 81 mg daily planned',
        formatted_test_results: '- Troponin: 0.01 ng/mL',
      }),
    );
    expect(composed.selected).toContain(ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY);
    expect(composed.prompt).toContain('MORNING NOTE: aspirin 81 mg daily planned');
    expect(composed.prompt).toContain('- Troponin: 0.01 ng/mL');
  });

  it('on a FIRST visit (the handoff publishes neither key) it is excluded cleanly and the prompt is the platform finalizer`s', () => {
    const composed = contract.composePrompt(composite(), durableScope({ visit_type: 'new-visit', formatted_test_results: '' }));
    expect(composed.selected).toEqual([CLINICAL_NOTE_FRAGMENT_KEY, ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY]);
    expect(composed.excluded).toEqual([{ key: ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY, reason: 'condition_false' }]);
  });
});

describe('phase 29 seeds it (so phase 26 does not clone the platform row over it)', () => {
  const fakeClient = (existingSlugs: string[] = []) => {
    const created: Array<Record<string, any>> = [];
    const client = {
      aiModel: {
        findMany: vi.fn(async () =>
          DEFAULT_AI_MODELS.map((model, index) => ({
            id: `model-${index}`,
            slug: model.slug,
            taskType: String(model.taskType),
            provider: model.provider ?? null,
            wireModelId: null,
          })),
        ),
      },
      promptTemplate: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          status: 'APPROVED',
          content: `content of ${where.id}`,
          approvedVersionNumber: 1,
          currentVersionNumber: 1,
        })),
      },
      promptVersion: { findFirst: vi.fn(async () => ({ content: 'versioned content' })) },
      agent: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async ({ where }: { where: { tenantId: string; slug: string } }) =>
          where.tenantId === ARCAAI && existingSlugs.includes(where.slug) ? { id: 'existing-clone' } : null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          created.push(data);
          return data;
        }),
      },
      agentModelFallback: { create: vi.fn(async () => ({})) },
      agentAssignment: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      department: { findMany: vi.fn(async () => []) },
      documentTemplate: { findFirst: vi.fn(async () => ({ id: 'dt' })), findUnique: vi.fn(async () => ({ id: 'dt' })) },
      workflowDefinition: { findUnique: vi.fn(async () => ({ id: 'wf' })), findFirst: vi.fn(async () => ({ id: 'wf' })) },
    };
    return { client, created };
  };

  it('creates ArcaAI `casenote-finalization` with the three fragments', async () => {
    const { client, created } = fakeClient();
    await seedArcaaiAgentsAndWorkflows(client as never).catch(() => undefined);
    const row = created.find((data) => data.slug === 'casenote-finalization');
    expect(row, 'phase 29 did not create the ArcaAI finalizer').toBeDefined();
    expect(row!.tenantId).toBe(ARCAAI);
    expect((row!.instruction as { fragments: Fragment[] }).fragments.map((fragment) => fragment.key)).toEqual([
      CLINICAL_NOTE_FRAGMENT_KEY,
      ARCAAI_SAME_DAY_RETURN_FRAGMENT_KEY,
      ARCAAI_OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY,
    ]);
  });

  it('leaves an ALREADY-provisioned tenant finalizer alone (the rollout script owns converting a live one)', async () => {
    const { client, created } = fakeClient(['casenote-finalization']);
    await seedArcaaiAgentsAndWorkflows(client as never).catch(() => undefined);
    expect(created.find((data) => data.slug === 'casenote-finalization')).toBeUndefined();
  });
});
