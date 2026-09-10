/**
 * TASK-947 §4.5 item 4 — the draft test bench renders `ack.composition` (selected/excluded
 * fragment keys, OD-11) beside the assembled prompt when the agent's instruction is the
 * fragments form; when it is absent (forms 1/2, or a server that predates this ticket) nothing
 * extra renders. `fetch` is stubbed at the network boundary, mirroring `draft-test-panel.task890
 * .test.tsx`.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { DraftTestPanel } from '../draft-test-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-1',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma',
    fallbacks: [],
    instruction: { fragments: [{ key: 'base', promptTemplateId: 'tpl-1' }, { key: 'revisit', promptTemplateId: 'tpl-1', when: "has(context.visit_type)" }] },
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

function stubFetch(response: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/admin/agents/a-1/test')) return Response.json(response);
      throw new Error(`Unhandled fetch: ${String(input)}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DraftTestPanel — composition (TASK-947)', () => {
  it('renders selected and excluded fragment keys when the ack carries a composition', async () => {
    stubFetch({
      mode: 'dry-run',
      findings: [],
      assembledSystemPrompt: 'base content',
      assembledUserPrompt: 'hello',
      resolved: { provider: 'lm-studio', model: 'gemma-4', fundingTier: 'platform', source: 'row' },
      composition: { selected: ['base'], excluded: [{ key: 'revisit', reason: 'condition_false' }] },
    });
    renderWithProviders(<DraftTestPanel agent={agent()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/selected:/)).toBeTruthy();
    expect(screen.getByText('base')).toBeTruthy();
    expect(screen.getByText(/excluded:/)).toBeTruthy();
    expect(screen.getByText('revisit (condition_false)')).toBeTruthy();
  });

  it('renders nothing extra when the ack carries no composition (forms 1/2, or a pre-TASK-947 server)', async () => {
    stubFetch({
      mode: 'dry-run',
      findings: [],
      assembledSystemPrompt: 'You are a scribe.',
      assembledUserPrompt: 'hello',
      resolved: { provider: 'lm-studio', model: 'gemma-4', fundingTier: 'platform', source: 'row' },
    });
    renderWithProviders(<DraftTestPanel agent={agent({ instruction: { systemPrompt: 'You are a scribe.' } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText('You are a scribe.');
    expect(screen.queryByText(/selected:/)).toBeNull();
  });
});
