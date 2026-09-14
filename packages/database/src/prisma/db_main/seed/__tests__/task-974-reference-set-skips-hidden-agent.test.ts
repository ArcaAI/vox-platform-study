/**
 * TASK-974 D-1, L5/F6 — the SEED's reference-set copy skips the PLATFORM HIDDEN agent.
 *
 * "Hidden" means, first of all, NEVER CLONED: the DNA analyst is CONFIGURATION the platform admin
 * owns, resolved for every tenant from the one SYSTEM row, not CONTENT a tenant owns a copy of
 * (D-1 vs. TASK-890 OD-M). `TenantReferenceSetService.copyAgents` enforced that at runtime, but
 * phase 26 is a SECOND implementation of the same copy for the seeded tenants — and it had no
 * such skip, so `pnpm db:seed` handed ArcaAI its own editable copy of the analyst, with the
 * platform admin's model in it and a `sourceAgentId` pointing back at the SYSTEM row.
 *
 * The allow-list is a literal in `00-constants.ts` because this package cannot import
 * `@arcaai/applications`; `platform-hidden-agents.test.ts` over there proves the two agree.
 */
import { describe, expect, it, vi } from 'vitest';

import { copyAgents } from '../26-tenant-reference-set';
import { PLATFORM_HIDDEN_AGENT_SLUGS, SYSTEM_TENANT_ID } from '../00-constants';

const TENANT = '50000000-0000-0000-0000-000000000001';

const agentRow = (slug: string, id: string) => ({
  id,
  tenantId: SYSTEM_TENANT_ID,
  slug,
  name: slug,
  description: null,
  task: 'TEXT_GENERATION',
  versionNumber: 1,
  modelId: 'model-1',
  instruction: { systemPrompt: 'Do the thing.' },
  parameters: {},
  inputSchema: null,
  outputSchema: null,
  tools: [],
  compiledConfig: {},
  compiledConfigChecksum: 'sum',
  validationReport: null,
  validatedAt: null,
});

/** The three delegates `copyAgents` touches, and nothing else. */
function fakeClient(sources: Array<ReturnType<typeof agentRow>>) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    client: {
      agent: {
        findMany: vi.fn(async () => sources),
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        }),
      },
      promptTemplate: { findFirst: vi.fn(async () => null) },
      agentModelFallback: { findMany: vi.fn(async () => []), create: vi.fn() },
    } as never,
  };
}

describe('phase 26 — copyAgents', () => {
  it('clones an ordinary SYSTEM agent', async () => {
    const { client, created } = fakeClient([agentRow('casenote-finalization', 'sys-1')]);

    expect(await copyAgents(client, TENANT)).toBe(1);
    expect(created.map((row) => row.slug)).toEqual(['casenote-finalization']);
  });

  it('never clones a platform hidden agent, and does not count it', async () => {
    const { client, created } = fakeClient([agentRow('casenote-finalization', 'sys-1'), agentRow('dna-writing-style-analyst', 'sys-2')]);

    expect(await copyAgents(client, TENANT)).toBe(1);
    expect(created.map((row) => row.slug)).toEqual(['casenote-finalization']);
    expect(created.some((row) => row.sourceAgentId === 'sys-2')).toBe(false);
  });

  it('skips EVERY declared hidden slug, so a second entry needs no change here', async () => {
    const { client, created } = fakeClient([...PLATFORM_HIDDEN_AGENT_SLUGS].map((slug, index) => agentRow(slug, `sys-${index}`)));

    expect(await copyAgents(client, TENANT)).toBe(0);
    expect(created).toEqual([]);
  });
});
