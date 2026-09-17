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
import type { Agent, AgentLineage } from '../../api/types';
import { AgentLineageDrawer } from '../agent-detail';

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

/**
 * TASK-965 WS-4 — the drawer is keyed by the lineage SLUG, not by a version row id, so a test
 * hands it the lineage the grid would have. This folds the one fixture row into that shape.
 */
function lineageFor(row: Agent): AgentLineage {
  const open = row.status === 'DRAFT' || row.status === 'VALIDATED';
  return {
    slug: row.slug,
    name: row.name,
    task: row.task,
    versionCount: 1,
    latestVersionNumber: row.versionNumber,
    deprecatedCount: row.status === 'DEPRECATED' ? 1 : 0,
    active: row.isActive
      ? { id: row.id, versionNumber: row.versionNumber, publishedAt: row.publishedAt, publishedBy: row.updatedBy, modelSlug: row.modelSlug, compiledConfigChecksum: row.compiledConfigChecksum }
      : null,
    draft: open ? { id: row.id, versionNumber: row.versionNumber, status: row.status as 'DRAFT' | 'VALIDATED', updatedAt: row.updatedAt } : null,
    assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTenantId: row.sourceTenantId, sourceSlug: row.sourceSlug },
    tags: row.tags,
    updatedAt: row.updatedAt,
    hidden: false,
  };
}

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
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
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

describe('AgentLineageDrawer — state does not leak across lineages (TASK-965 WS-1 AG-1, re-pinned at lineage scope by WS-4)', () => {
  it('closes an open edit form when the drawer is pointed at another lineage', async () => {
    // WS-4 moved the boundary: the drawer no longer switches between VERSIONS of one agent (the
    // Versions tab does that in place), it switches between AGENTS as the grid selection moves.
    // That is where an edit form seeded from one draft could now be saved onto another's.
    const first = agent();
    const second = agent({ id: 'b-1', slug: 'ward-triage', name: 'Ward triage', versionNumber: 1 });
    stubFetch([first, second]);
    const { rerender } = renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(first)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Edit draft' }));
    expect(await within(drawer).findByRole('button', { name: 'Save draft' })).toBeTruthy();

    rerender(<AgentLineageDrawer slug="ward-triage" lineage={lineageFor(second)} onOpenChange={vi.fn()} />);

    await screen.findByText('Ward triage');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull());
  });
});

describe('AgentLineageDrawer — assignment copy tells the fail-closed truth (TASK-965 WS-1, AG-3/AG-4)', () => {
  it('with no assignment for the task, says the task is unassigned and fails closed — never "the platform default" (AG-3)', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-10T10:00:00.000Z' });
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    // WS-4: assignment is per SLUG, so it answers on the lineage's own Assignments tab.
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });
    expect(await within(drawer).findByText(/AGENT_NOT_ASSIGNED/)).toBeTruthy();
    expect(within(drawer).queryByText(/currently the platform default/i)).toBeNull();
  });

  it('the Deprecate confirm names the assignment that will point at nothing (AG-4)', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-10T10:00:00.000Z' });
    const assigned = { ...lineageFor(row), assignment: { tenantDefault: true, departmentCount: 2, selectorCount: 0 } };
    stubFetch([row], [TENANT_DEFAULT_ROW]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={assigned} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    // Deprecation retires a VERSION, so the verb lives on that version's row menu; the kit's
    // dialog is what names the consequence (`shared/versioning/lifecycle-dialogs.tsx`).
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Versions' }), { button: 0 });
    await within(drawer).findByRole('list', { name: 'Versions of clinic-summarizer' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for v1' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deprecate v1' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/will stop resolving until another version is activated/);
    expect(confirm.textContent).toMatch(/tenant default/i);
    expect(confirm.textContent).toMatch(/2 department assignments name this slug and will resolve to nothing/);
  });
});

describe('AgentLineageDrawer — Integration tab (TASK-965, O-2 / AG-8)', () => {
  it('a PUBLISHED row exposes its endpoint and vox-node snippet from the Integration tab, long after the publish dialog is gone', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-10T10:00:00.000Z' });
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Integration' }), { button: 0 });

    expect(await within(drawer).findByText('POST /agents/clinic-summarizer/invocations')).toBeTruthy();
    expect(within(drawer).getByRole('group', { name: /vox-node/i }).textContent).toContain('hope.agents.invoke');
    expect((within(drawer).getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
  });

  it('a DRAFT row explains that publishing is what exposes the endpoint', async () => {
    const row = agent();
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Integration' }), { button: 0 });

    expect(await within(drawer).findByText(/not published yet/i)).toBeTruthy();
    expect(within(drawer).queryByText(/POST \/agents/)).toBeNull();
  });
});
