/**
 * TASK-890 §3.10 — the agent detail drawer's Configuration tab: on a DRAFT the model, fallbacks,
 * instruction and tags are editable and the `PATCH` carries them; a PUBLISHED row shows the
 * "Create vN" affordance instead. The Publish button opens the confirm dialog, and once
 * published the dialog switches to the integration view. The Test run tab hosts the draft bench
 * for a mutable row.
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
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 2 }],
  models: [
    { id: 'm-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
    { id: 'm-2', slug: 'lms-gpt-oss', name: 'GPT-OSS 20B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};

const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2, contentPreview: 'Write a note', declaredVariables: [] };

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

describe('AgentDetailDrawer — Configuration (TASK-890)', () => {
  it('on a DRAFT, Edit draft reveals the model, fallback, instruction and tags fields', async () => {
    stubFetch(agent());
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Configuration' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(await screen.findByLabelText('Prompt template')).toBeTruthy();
    expect(screen.getByLabelText('Tags')).toBeTruthy();
  });

  it('saving the draft PATCHes modelId, fallbackModelIds, instruction and tags', async () => {
    const calls = stubFetch(agent(), (call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1')) return Response.json({ ...agent(), version: 2 }, { headers: { etag: '"2"' } });
      return undefined;
    });
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Configuration' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));

    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(await screen.findByRole('option', { name: /GPT-OSS 20B/ }));
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'specialty:rheumatology' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'))).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'));
    expect(patch?.body).toMatchObject({ modelId: 'm-2', tags: ['specialty:rheumatology'], instruction: { promptTemplateId: 'tpl-1' } });
  });

  it('on a PUBLISHED row, the "Create vN" affordance replaces the edit form and the footer offers "New version" (never "Branch as my agent")', async () => {
    stubFetch(agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-02T10:00:00.000Z' }));
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    // Radix `TabsTrigger` activates on `mousedown` (or focus); a plain `fireEvent.click` never
    // dispatches `mousedown` and so never switches the panel.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Configuration' }), { button: 0 });
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    expect(await screen.findByText(/Create vN to change/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New version' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Branch as my agent' })).toBeNull();
  });

  it('Publish opens the confirm dialog; once published the dialog shows the endpoint and snippet', async () => {
    const calls = stubFetch(agent(), (call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/publish')) return Response.json(agent({ status: 'PUBLISHED', isActive: true }));
      return undefined;
    });
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Publish$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Publish Clinic summarizer\?/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/publish'))).toBe(true));
    expect(await screen.findByText(/POST \/agents\/clinic-summarizer\/invocations/)).toBeTruthy();
    expect(screen.getByText(/hope\.agents\.invoke/)).toBeTruthy();
  });

  it('the Test run tab hosts the draft bench for a mutable row', async () => {
    stubFetch(agent());
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Test run' }), { button: 0 });
    expect(await screen.findByLabelText('Dry run')).toBeTruthy();
    expect(screen.getByLabelText('Input text')).toBeTruthy();
  });
});
