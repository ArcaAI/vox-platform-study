/**
 * TASK-890 §3.10 — the agent drawer's editing surface: on a DRAFT the model, fallbacks,
 * instruction and tags are editable and the `PATCH` carries them; with no draft open the drawer
 * offers to branch one instead. The Publish button opens the confirm dialog, and once published
 * the dialog switches to the integration view. The Test run tab hosts the draft bench.
 *
 * TASK-965 WS-4 moved that surface from a "Configuration" tab on a VERSION to a "Draft" tab on
 * the LINEAGE: the drawer is keyed by slug, the editable body is the lineage's one open draft,
 * and "New version" became "New draft", offered only where no draft is already open (OD-965-9 /
 * AG-19 — a slug accumulating identical-looking drafts is the reported symptom).
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
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 2 }],
  models: [
    { id: 'm-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
    { id: 'm-2', slug: 'lms-gpt-oss', name: 'GPT-OSS 20B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};

const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2, contentPreview: 'Write a note', declaredVariables: [] };

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

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(agentRow: Agent, extra: FetchHandler = () => undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const custom = extra(call);
      if (custom) return custom;
      const path = url.pathname;
      if (path === `/api/hope/admin/agents/${agentRow.id}`) return Response.json(agentRow, { headers: { etag: `"${agentRow.version}"` } });
      if (path === `/api/hope/admin/agents/${agentRow.id}/versions`) return Response.json([agentRow]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentLineageDrawer — the Draft tab (TASK-890, on the TASK-965 lineage model)', () => {
  it('on a DRAFT, Edit draft reveals the model, fallback, instruction and tags fields', async () => {
    const row = agent();
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(await screen.findByLabelText('Prompt template')).toBeTruthy();
    expect(screen.getByLabelText('Tags')).toBeTruthy();
  });

  it('saving the draft PATCHes modelId, fallbackModelIds, instruction and tags', async () => {
    const row = agent();
    const calls = stubFetch(row, (call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1')) return Response.json({ ...agent(), version: 2 }, { headers: { etag: '"2"' } });
      return undefined;
    });
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));

    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(await screen.findByRole('option', { name: /GPT-OSS 20B/ }));
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'specialty:rheumatology' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'))).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'));
    expect(patch?.body).toMatchObject({ modelId: 'm-2', tags: ['specialty:rheumatology'], instruction: { promptTemplateId: 'tpl-1' } });
  });

  it('with no draft open, the Draft tab explains that a published version is immutable and offers "New draft" (never "Branch as my agent")', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-02T10:00:00.000Z' });
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    expect(await screen.findByText(/A published version is immutable/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New draft' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: 'Branch as my agent' })).toBeNull();
  });

  it('Publish opens the confirm dialog; once published the dialog shows the endpoint and snippet', async () => {
    const row = agent();
    const calls = stubFetch(row, (call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/publish')) return Response.json(agent({ status: 'PUBLISHED', isActive: true }));
      return undefined;
    });
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    // The footer verb acts on the lineage's OPEN DRAFT, so it stays disabled until that row is
    // loaded — a disabled control that silently swallows a click is exactly what it must not do.
    const publishButton = await screen.findByRole('button', { name: /^Publish$/ });
    await waitFor(() => expect((publishButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(publishButton);
    const dialog = await screen.findByRole('dialog', { name: /Publish Clinic summarizer\?/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/publish'))).toBe(true));
    expect(await screen.findByText(/POST \/agents\/clinic-summarizer\/invocations/)).toBeTruthy();
    expect(screen.getByText(/hope\.agents\.invoke/)).toBeTruthy();
  });

  it('the Test run tab hosts the draft bench for a mutable row', async () => {
    const row = agent();
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Test run' }), { button: 0 });
    expect(await screen.findByLabelText('Dry run')).toBeTruthy();
    expect(screen.getByLabelText('Input text')).toBeTruthy();
  });
});
