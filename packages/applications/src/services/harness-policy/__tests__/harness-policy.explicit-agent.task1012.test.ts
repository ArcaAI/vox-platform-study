/**
 * TASK-1012 L-3 — the business text plane selects a model ONLY through an Agent: the caller names
 * a TEXT_GENERATION agent (`agentSlug`) or the assignment cascade decides. `resolveTextSelection`
 * is that seam, so an explicit slug has to reach `TextAgentResolverService` — and an explicit slug
 * the tenant cannot see stays the 404 the agent resolver answers (404-over-403), not the
 * "nothing is assigned" 400 the cascade reports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
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

beforeEach(() => {
  vi.clearAllMocks();
  textAgents.resolve.mockResolvedValue({ primary: { provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', parameters: {} } });
});

describe('resolveTextSelection — an explicit TEXT_GENERATION agent', () => {
  it('passes the caller-named agentSlug to the agent resolver', async () => {
    await expect(makeService().resolveTextSelection(TENANT, 'finalize', null, 'clinic-summarizer')).resolves.toEqual({
      provider: 'lm-studio',
      model: 'gemma-4-e2b-it-qat',
    });
    expect(textAgents.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      departmentId: null,
      agentSlug: 'clinic-summarizer',
      selectorTags: ['phase:finalize'],
    });
  });

  it('an explicit slug the tenant cannot see stays a 404 (never re-worded as "nothing assigned")', async () => {
    textAgents.resolve.mockRejectedValue(new NotFoundException("Agent 'foreign' not found"));
    await expect(makeService().resolveTextSelection(TENANT, 'finalize', null, 'foreign')).rejects.toBeInstanceOf(NotFoundException);
  });
});
