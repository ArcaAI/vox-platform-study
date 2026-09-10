/**
 * TASK-947 — a TEXT candidate carries the COMPOSITE `resolvedPrompt` through UNCHANGED.
 *
 * `toTextCandidate` is the chokepoint every TEXT lane reads its prompt from — the live loop, the
 * Temporal `core.agent` activity, every `resolveTextSelection` caller. It is a projection, not a
 * renderer: if it flattened a composite to its static projection, or dropped `fragments` because
 * the old shape had none, every one of those lanes would silently serve the BASE prompt and no
 * conditional fragment would ever run again — with no error anywhere to say so.
 *
 * So the assertion is deliberately a deep equality against the artifact publish stamped, not a
 * spot-check of two fields.
 */
import { describe, expect, it } from 'vitest';
import type { AgentCompiledConfig, ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { toTextCandidate } from '../text-generation-spec';

const TENANT = 'tenant-aaa';

const COMPOSITE: AgentCompiledConfig['resolvedPrompt'] = {
  source: 'composite',
  join: '\n\n',
  content: 'You are a scribe.',
  fragments: [
    { key: 'base', source: 'template', promptTemplateId: 'tpl-base', promptVersionNumber: 3, content: 'You are a scribe.', when: null },
    {
      key: 'revisit',
      source: 'template',
      promptTemplateId: 'tpl-revisit',
      promptVersionNumber: 5,
      content: 'This is a follow-up visit.',
      when: "has(context.visit_type) && context.visit_type == 'revisit'",
    },
    { key: 'peds', source: 'inline', content: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
  ],
};

function agent(resolvedPrompt: AgentCompiledConfig['resolvedPrompt']): ResolvedAgent {
  return {
    slug: 'clinic-summariser',
    agentVersionId: 'ver-1',
    versionNumber: 3,
    tenantId: TENANT,
    source: 'tenant',
    models: [],
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      resolvedPrompt,
      instruction: { fragments: [{ key: 'base', promptTemplateId: 'tpl-base' }] },
      parameters: {},
      tools: [],
    },
  } as unknown as ResolvedAgent;
}

const model = (): ResolvedAgentModel =>
  ({
    role: 'primary',
    slug: 'lms-gemma',
    wireModelId: 'gemma-4-e2b-it-qat',
    provider: 'lm-studio',
    tenantId: TENANT,
    format: 'GGUF',
  }) as unknown as ResolvedAgentModel;

const funding = { fundingTier: 'tenant' as const, providerOverride: undefined };

describe('toTextCandidate passes a composite resolvedPrompt through', () => {
  it('carries the artifact publish stamped, fragments and conditions intact', () => {
    const candidate = toTextCandidate(agent(COMPOSITE), model(), 'primary', funding);

    expect(candidate?.resolvedPrompt).toEqual(COMPOSITE);
    // Never flattened to the static projection: the fragment list IS the contract the renderers read.
    expect((candidate?.resolvedPrompt as { fragments: unknown[] }).fragments).toHaveLength(3);
  });

  it('still passes the two pre-947 shapes through unchanged', () => {
    expect(toTextCandidate(agent({ source: 'inline', content: 'PROMPT' }), model(), 'primary', funding)?.resolvedPrompt).toEqual({
      source: 'inline',
      content: 'PROMPT',
    });
    expect(toTextCandidate(agent(null), model(), 'primary', funding)?.resolvedPrompt).toBeNull();
  });
});
