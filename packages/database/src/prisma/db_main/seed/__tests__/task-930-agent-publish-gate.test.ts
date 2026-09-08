/**
 * TASK-930 D-6 — every seeded PUBLISHED agent must survive the gate the API enforces.
 *
 * The §6.9 local run cloned the seeded, already-PUBLISHED `general-medicine-summarization` and
 * could not re-publish it: `parameters.generation.reasoning` was refused as unsupported by
 * `lm-studio/lms-gemma-4-e2b-it-qat`. The seed had written a row past a validator the API applies
 * to every author.
 *
 * `task-930-agents.test.ts` did not catch it because it calls `agentConfigProblems` WITHOUT
 * `capabilities` — and the capability arm is the whole gate here (`agentic-contract.ts`
 * `hyperparameterCapabilityProblems`). This file supplies capabilities the way the service does
 * (`AgentService.capabilitiesOf`: `metaData.capabilities ?? metaData`, label
 * `<provider>/<slug>`), read off the REAL catalogue rows in `06-ai-models.ts`, and runs the
 * check over every seeded agent — the five Global, the five SYSTEM, and the 22 ArcaAI department
 * agents, all of which share `SUMMARIZATION_PARAMETERS`.
 *
 * Hermetic: pure data in, pure findings out; the contract is imported from SOURCE, exactly as the
 * sibling seed tests do.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS, type SeedAgentSpec } from '../25-agents';
import { ARCAAI_AGENT_SPECS } from '../29-arcaai-agents-and-workflows';
import { SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { agentConfigProblems, AGENT_TASKS } = contract;

const ALL_SPECS: SeedAgentSpec[] = [...PLATFORM_AGENT_SPECS, ...GLOBAL_AGENT_SPECS, ...ARCAAI_AGENT_SPECS];

const MODEL_BY_SLUG = new Map(DEFAULT_AI_MODELS.map((model) => [model.slug, model]));

function modelOrThrow(slug: string) {
  const model = MODEL_BY_SLUG.get(slug);
  if (!model) throw new Error(`'${slug}' is not a row of DEFAULT_AI_MODELS — the seed may not bind it`);
  return model;
}

/** `AgentService.capabilitiesOf`, verbatim in behaviour: `metaData.capabilities ?? metaData`. */
function capabilitiesOf(slug: string) {
  const model = modelOrThrow(slug);
  const meta = (model.metaData ?? {}) as Record<string, unknown>;
  const caps = (meta.capabilities as Record<string, unknown> | undefined) ?? meta;
  return {
    supportedGenerationParams: Array.isArray(caps.supportedGenerationParams) ? (caps.supportedGenerationParams as string[]) : undefined,
    supportsSsml: typeof caps.supportsSsml === 'boolean' ? caps.supportsSsml : undefined,
    label: `${model.provider ?? 'local'}/${model.slug}`,
  };
}

const label = (spec: SeedAgentSpec) => `${spec.tenantId === SYSTEM_TENANT_ID ? 'SYSTEM' : spec.tenantId.slice(0, 8)}/${spec.slug}`;

describe('TASK-930 D-6 — a seeded published agent passes the publish gate the API enforces', () => {
  it('the fixture covers all three seeded agent sets', () => {
    expect(PLATFORM_AGENT_SPECS.length).toBeGreaterThan(0);
    expect(GLOBAL_AGENT_SPECS.length).toBe(PLATFORM_AGENT_SPECS.length);
    expect(ARCAAI_AGENT_SPECS.length).toBe(22);
  });

  it.each(ALL_SPECS.map((spec) => [label(spec), spec] as const))(
    '%s: agentConfigProblems WITH the bound model`s declared capabilities reports no ERROR',
    (_label, spec) => {
      if (!(AGENT_TASKS as readonly string[]).includes(spec.task)) return;
      const model = modelOrThrow(spec.modelSlug);
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
          fallbackModels: spec.fallbackModelSlugs.map((slug) => {
            const fallback = modelOrThrow(slug);
            return { slug: fallback.slug, taskType: String(fallback.taskType), provider: fallback.provider ?? undefined };
          }),
          capabilities: capabilitiesOf(spec.modelSlug),
        },
      );
      expect(problems.filter((problem: { severity: string }) => problem.severity === 'ERROR'), JSON.stringify(problems)).toEqual([]);
    },
  );

  it('the reasoning posture the summarization agents author is DECLARED by the model they bind', () => {
    // `enabled: false` is not decoration: it reaches the engine as `reasoning_effort: 'minimal'`
    // (`agent-reasoning.ts`), and TASK-891 measured 5168ms/184 reasoning tokens unset against
    // 1237ms/30 with it on this exact model. Dropping it from the seed would silently restore the
    // engine default on a 20 s realtime budget — so the capability must be declared, not the
    // parameter removed.
    const summarizers = ALL_SPECS.filter((spec) => (spec.parameters as any)?.generation?.reasoning !== undefined);
    expect(summarizers.length).toBeGreaterThan(0);
    for (const spec of summarizers) {
      expect((spec.parameters as any).generation.reasoning).toEqual({ enabled: false });
      expect(capabilitiesOf(spec.modelSlug).supportedGenerationParams).toContain('reasoning');
    }
  });
});
