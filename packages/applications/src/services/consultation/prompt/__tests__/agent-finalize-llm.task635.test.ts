/**
 * Finalize LLM precedence.
 *
 * agent `llmOverrides.finalize` → tenant `text.finalize` AiTaskDefault →
 * fail-closed. Model SELECTION is fail-CLOSED on finalize (rule 09
 * §Configuration Tiers), which is the deliberate opposite of the live side's
 * fail-open `resolveLiveLlm` — a clinical note must not be finalized on a
 * different model than the one that was configured, silently.
 */

import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ModelTaskType } from '@arcaai/domains';

import { resolveAgentFinalizeSelection } from '../agent-finalize-llm';

const enabledModel = (overrides: Record<string, unknown> = {}) => ({
  provider: 'openai',
  sourceUri: 'gpt-4.1',
  taskType: ModelTaskType.TEXT_GENERATION,
  ...overrides,
});

const deps = (agent: unknown, models: unknown[] = [enabledModel()]) => ({
  departmentAgentRepository: { findById: vi.fn().mockResolvedValue(agent) },
  aiModelRepository: { findAll: vi.fn().mockResolvedValue(models) },
});

describe('resolveAgentFinalizeSelection', () => {
  it('resolves the agent override to a concrete {provider, model}', async () => {
    const d = deps({ llmOverrides: { finalize: { aiModelSlug: 'gpt-4-1' } } });

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).resolves.toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it("maps the catalog's `azure` provider to TEXT's `azure-openai`", async () => {
    const d = deps({ llmOverrides: { finalize: { aiModelSlug: 'az' } } }, [enabledModel({ provider: 'azure', sourceUri: 'gpt-4o' })]);

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).resolves.toEqual({ provider: 'azure-openai', model: 'gpt-4o' });
  });

  it('reads ONLY the finalize key — a live-only override must never drive finalize', async () => {
    const d = deps({ llmOverrides: { live: { aiModelSlug: 'tiny-fast' } } });

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).resolves.toBeNull();
    expect(d.aiModelRepository.findAll).not.toHaveBeenCalled();
  });

  it.each([
    ['the slug matches nothing ENABLED', []],
    ['the model is not TEXT_GENERATION', [enabledModel({ taskType: ModelTaskType.EMBEDDING })]],
    ['the model has no sourceUri', [enabledModel({ sourceUri: null })]],
    ['the model has no provider', [enabledModel({ provider: null })]],
  ])('FAILS CLOSED when %s', async (_label, models) => {
    const d = deps({ llmOverrides: { finalize: { aiModelSlug: 'ghost' } } }, models);

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    ['there is no lineage agent', undefined],
    ['the agent id is null', null],
  ])('applies NO override when %s (tenant tier decides, unchanged)', async (_label, agentId) => {
    const d = deps({ llmOverrides: { finalize: { aiModelSlug: 'gpt-4-1' } } });

    await expect(resolveAgentFinalizeSelection(d as never, agentId as never)).resolves.toBeNull();
    expect(d.departmentAgentRepository.findById).not.toHaveBeenCalled();
  });

  it('applies NO override when the repositories are unwired (legacy fixtures)', async () => {
    await expect(resolveAgentFinalizeSelection({}, 'agent-1')).resolves.toBeNull();
  });

  it('a vanished agent row falls through to the tenant tier rather than failing', async () => {
    const d = {
      departmentAgentRepository: { findById: vi.fn().mockRejectedValue(new Error('not found')) },
      aiModelRepository: { findAll: vi.fn() },
    };

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).resolves.toBeNull();
  });

  it('an agent with no llmOverrides applies no override', async () => {
    const d = deps({ llmOverrides: null });

    await expect(resolveAgentFinalizeSelection(d as never, 'agent-1')).resolves.toBeNull();
  });
});
