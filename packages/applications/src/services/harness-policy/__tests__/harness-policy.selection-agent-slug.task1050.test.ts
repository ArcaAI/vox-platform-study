/**
 * TASK-1050 finding D — the text selection names the AGENT that serves it, so every gateway → TEXT
 * caller that selects through this seam can state `agent_slug` on its guardrail evaluation record.
 * Before, the seam returned `{ provider, model }` and the agent was dropped, so the live lane's and
 * the pre-summary's evaluations carried an empty `agentSlug`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const textAgents = { resolve: vi.fn() };

function makeService(): HarnessPolicyService {
  return new HarnessPolicyService(
    {} as never,
    {} as never,
    {} as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) } as never,
    undefined,
    { resolveDefault: vi.fn() } as never,
    undefined,
    undefined,
    textAgents as never,
  );
}

const candidate = (slug: string, model: string) => ({ agent: { slug }, provider: 'lm-studio', model, parameters: {} });

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue({
    primary: candidate('platform-summarization-live', 'gemma'),
    fallback: { autoSwitch: true, chain: [candidate('reasoning-fallback', 'reasoner')] },
  });
});

describe('the text selection carries the serving agent', () => {
  it('resolveTextSelection names the primary candidate agent', async () => {
    await expect(makeService().resolveTextSelection(TENANT, 'live')).resolves.toMatchObject({ agentSlug: 'platform-summarization-live' });
  });

  it('resolveTextFallbackSelection names the fallback candidate agent', async () => {
    await expect(makeService().resolveTextFallbackSelection(TENANT, 'finalize')).resolves.toMatchObject({ agentSlug: 'reasoning-fallback' });
  });
});
