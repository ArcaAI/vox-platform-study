/**
 * What the gateway → harness resolved-agent wire carries for LLM egress.
 *
 *  - `deploymentKind` on every `ResolvedAgent.models[]` entry and on every `ResolvedTextCandidate`
 *    (`textPrimary`, each `textFallback.chain[]` entry): the harness stamps `provider_locality` on
 *    its own `/generate` calls from it. Absent, `apps/text` treats a non-engine-served provider as
 *    cloud (fail closed).
 *  - `outputSchema` on each candidate: the candidate agent's OWN output schema (null when it has
 *    none), so a fallback never runs under the primary's schema unless it has none of its own.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { toTextCandidate } from '../text-generation-spec';

function agent(outputSchema?: Record<string, unknown>): ResolvedAgent {
  return {
    slug: 'clinic-summariser',
    agentVersionId: 'ver-1',
    versionNumber: 3,
    tenantId: 'tenant-a',
    source: 'tenant',
    models: [],
    compiledConfig: { task: 'TEXT_GENERATION', service: 'llm', parameters: {}, ...(outputSchema ? { outputSchema } : {}) },
  } as unknown as ResolvedAgent;
}

function model(over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel {
  return {
    role: 'primary',
    slug: 'lms-gemma',
    sourceUri: 'gemma',
    sourceRevision: null,
    localPath: null,
    wireModelId: 'gemma-4-e2b-it-qat',
    checksum: null,
    format: 'GGUF',
    computeType: null,
    provider: 'lm-studio',
    tenantId: 'tenant-a',
    ...over,
  } as ResolvedAgentModel;
}

describe('ResolvedTextCandidate — egress facts on the wire', () => {
  it('carries the serving row`s deploymentKind, and omits it when the row has none', () => {
    expect(toTextCandidate(agent(), model({ deploymentKind: 'SELF_HOSTED' }), 'primary', { fundingTier: 'tenant' })?.deploymentKind).toBe('SELF_HOSTED');
    expect(toTextCandidate(agent(), model({ deploymentKind: 'CLOUD' }), 'fallback-model', { fundingTier: 'tenant' })?.deploymentKind).toBe('CLOUD');
    expect(toTextCandidate(agent(), model(), 'primary', { fundingTier: 'tenant' })).not.toHaveProperty('deploymentKind');
  });

  it('carries the candidate agent`s OWN outputSchema, null when it declares none', () => {
    const schema = { type: 'object', properties: { note: { type: 'string' } } };
    expect(toTextCandidate(agent(schema), model(), 'fallback-agent', { fundingTier: 'tenant' })?.outputSchema).toEqual(schema);
    expect(toTextCandidate(agent(), model(), 'fallback-agent', { fundingTier: 'tenant' })?.outputSchema).toBeNull();
  });
});
