/**
 * TASK-947 R1 #1 — a TEXT candidate carries the agent's FROZEN context schema, so the realtime
 * lane can apply the same single-kind unwrap the invocation route, the bench and the durable lane
 * apply (`compiledConfig.contextSchema.payloadSchema`). Absent on the agent ⇒ `null` on the
 * candidate; the Python `TextFallbackCandidate` ignores unknown fields, so the wire is unchanged
 * for it.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { toTextCandidate } from '../text-generation-spec';

const model = { role: 'primary', priority: 0, id: 'm-1', slug: 'lms-gemma', provider: 'lm-studio', wireModelId: 'gemma-4' } as never;

function agent(contextSchema: unknown): ResolvedAgent {
  return {
    agentId: 'a-1',
    agentVersionId: 'a-1',
    slug: 'summarizer',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: 't-1',
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm-1', slug: 'lms-gemma', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
      fallbacks: [],
      instruction: { systemPrompt: 'x' },
      resolvedPrompt: { source: 'inline', content: 'x' },
      parameters: {},
      inputSchema: {},
      outputSchema: {},
      tools: [],
      ...(contextSchema === undefined ? {} : { contextSchema }),
    },
    models: [model],
  } as unknown as ResolvedAgent;
}

const frozen = {
  schemaId: 's-1',
  versionNumber: 2,
  versionId: 'sv-1',
  payloadSchema: { type: 'object', additionalProperties: false, properties: { context: { type: 'object' } }, required: ['context'] },
};

describe('toTextCandidate — carries the frozen context schema', () => {
  it('copies `compiledConfig.contextSchema` onto the candidate', () => {
    expect(toTextCandidate(agent(frozen), model, 'primary', { fundingTier: 'tenant' } as never)?.contextSchema).toEqual(frozen);
  });

  it('is `null` when the agent pins no schema (absent or null)', () => {
    expect(toTextCandidate(agent(undefined), model, 'primary', { fundingTier: 'tenant' } as never)?.contextSchema).toBeNull();
    expect(toTextCandidate(agent(null), model, 'primary', { fundingTier: 'tenant' } as never)?.contextSchema).toBeNull();
  });
});
