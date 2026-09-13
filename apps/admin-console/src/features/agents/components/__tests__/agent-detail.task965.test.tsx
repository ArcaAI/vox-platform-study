/**
 * TASK-965 WS-1 — the agent detail drawer's state discipline and its assignment copy.
 *
 *  - AG-1: the drawer's local state (an open edit form above all) must not survive a switch to
 *    another version — an edit form seeded from v1 was saving onto v2.
 *  - AG-3: with no assignment for the task the copy read "Currently the platform default", but
 *    resolution is department → tenant and then a fail-closed 503 `AGENT_NOT_ASSIGNED`.
 *  - AG-4: deprecating the active version of the tenant-default slug leaves the assignment
 *    pointing at nothing; the confirm has to say so.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { AgentDetailDrawer } from '../agent-detail';

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
    instruction: { promptTemplateId: 'tpl-1' },
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
    tags: ['specialty:general'],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

const CATALOGUE = {
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 1 }],
  models: [
    { id: 'm-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};
const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2, contentPreview: 'Write a note', declaredVariables: [] };
const TENANT_DEFAULT_ROW = { id: 'as-1', tenantId: 'tnt-1', scope: 'TENANT', scopeId: null, task: 'TEXT_GENERATION', agentSlug: 'clinic-summarizer', selectorTags: [], version: 1, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' };

function stubFetch(rows: Agent[], assignments: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      for (const row of rows) {
        if (path === `/api/hope/admin/agents/${row.id}`) return Response.json(row, { headers: { etag: `"${row.version}"` } });
        if (path === `/api/hope/admin/agents/${row.id}/versions`) return Response.json(rows);
      }
      if (path === '/api/hope/admin/agent-assignments') return Response.json(assignments);
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('AgentDetailDrawer — state does not leak across versions (TASK-965 WS-1, AG-1)', () => {
  it('closes an open edit form when the drawer is pointed at another version', async () => {
    const v1 = agent();
    const v2 = agent({ id: 'a-2', versionNumber: 2, name: 'Clinic summarizer v2' });
    stubFetch([v1, v2]);
    const { rerender } = renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Configuration' }), { button: 0 });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Edit draft' }));
    expect(await within(drawer).findByRole('button', { name: 'Save draft' })).toBeTruthy();

    rerender(<AgentDetailDrawer agentId="a-2" onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    await screen.findByText('Clinic summarizer v2');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull());
  });
});

describe('AgentDetailDrawer — assignment copy tells the fail-closed truth (TASK-965 WS-1)', () => {
  it('with no assignment for the task, says the task is unassigned and fails closed — never "the platform default" (AG-3)', async () => {
    stubFetch([agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-10T10:00:00.000Z' })]);
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/AGENT_NOT_ASSIGNED/)).toBeTruthy();
    expect(within(drawer).queryByText(/currently the platform default/i)).toBeNull();
  });

  it('the Deprecate confirm names the assignment that will point at nothing (AG-4)', async () => {
    stubFetch([agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-10T10:00:00.000Z' })], [TENANT_DEFAULT_ROW]);
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={vi.fn()} onSelect={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('Tenant default');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Deprecate' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/tenant default/i);
    expect(confirm.textContent).toMatch(/AGENT_NOT_ASSIGNED/);
  });
});
