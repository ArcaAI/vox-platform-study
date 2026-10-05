/**
 * TASK-1036 C5 (W2) — the draft editor on the agents screen: the simple settings replace the raw
 * parameter tree (no top-p, no seed), guardrails read as "always on", agent tags autocomplete
 * from `GET admin/agents/tags`, and a stored platform-managed value is carried through a save.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
    {
      id: 'm-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served',
      readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null,
      capabilities: { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] },
    },
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

interface Call { url: string; method: string; body: unknown }

function stubFetch(row: Agent): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const path = url.pathname;
      if (path === `/api/hope/admin/agents/${row.id}` && (init?.method ?? 'GET') === 'PATCH') return Response.json({ ...row, version: 2 }, { headers: { etag: '"2"' } });
      if (path === `/api/hope/admin/agents/${row.id}`) return Response.json(row, { headers: { etag: `"${row.version}"` } });
      if (path === `/api/hope/admin/agents/${row.id}/versions`) return Response.json([row]);
      if (path === '/api/hope/admin/agents/tags') return Response.json([{ tag: 'dept:cardiology', count: 3 }]);
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      if (path.endsWith('auth/session')) return Response.json({ user: { id: 'u', roles: [] }, effectiveIsElevated: false, isElevated: false });
      return Response.json([]);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openEditor(row: Agent) {
  renderWithProviders(<AgentLineageDrawer slug={row.slug} lineage={lineageFor(row)} onOpenChange={() => undefined} />);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
  fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
}

describe('AgentLineageDrawer — the simple draft editor (TASK-1036 W2)', () => {
  it('shows temperature, max output tokens and guardrails-always-on, and none of the platform-managed knobs', async () => {
    stubFetch(agent());
    await openEditor(agent());
    expect(await screen.findByLabelText('Temperature')).toBeTruthy();
    expect(screen.getByLabelText('Max output tokens')).toBeTruthy();
    expect(screen.getByText(/Guardrails: always on/i)).toBeTruthy();
    expect(screen.queryByLabelText('Top P')).toBeNull();
    expect(screen.queryByLabelText('Seed')).toBeNull();
  });

  it('autocompletes agent tags from GET admin/agents/tags and refuses a bare tag', async () => {
    const calls = stubFetch(agent());
    await openEditor(agent());
    const tags = await screen.findByRole('combobox', { name: /tags/i });
    fireEvent.focus(tags);
    expect(await screen.findByText('dept:cardiology')).toBeTruthy();
    expect(calls.some((call) => call.url.includes('admin/agents/tags'))).toBe(true);
    fireEvent.change(tags, { target: { value: 'bare' } });
    expect(await screen.findByText(/not a valid agent tag/)).toBeTruthy();
  });

  it('keeps a stored platform-managed value when the draft is saved', async () => {
    const row = agent({ parameters: { generation: { temperature: 0.2, topP: 0.9 } } });
    const calls = stubFetch(row);
    await openEditor(row);
    fireEvent.change(await screen.findByLabelText('Temperature'), { target: { value: '0.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({ parameters: { generation: { temperature: 0.4, topP: 0.9 } } });
  });
});
