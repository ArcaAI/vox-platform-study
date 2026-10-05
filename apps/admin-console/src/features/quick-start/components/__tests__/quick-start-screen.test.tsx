/**
 * Quick start: one page from a context schema to a governing workflow, driving the existing admin
 * endpoints in order with a per-step progress line and a link out to each full editor.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { setTemplateEditorValue } from '@/test/template-editor';
import { QuickStartBody } from '../quick-start-screen';

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const MODELS = {
  providers: [],
  models: [{ id: 'model-1', slug: 'gemma', name: 'Gemma 4', taskType: 'TEXT_GENERATION', providerId: 'p', provider: 'lmstudio', providerClass: 'BUILT_IN', readiness: 'READY', readinessCheckedAt: null, readinessDetail: null, usable: true, description: null }],
};

function stub(failOn?: string): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const method = init?.method ?? 'GET';
      calls.push({ path: url.pathname, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const path = url.pathname.replace('/api/hope/', '');
      if (failOn && path === failOn && method === 'POST') return Response.json({ message: 'AGENT_SLUG_TAKEN' }, { status: 409 });
      if (path === 'admin/ai-models/catalogue') return Response.json(MODELS);
      if (path === 'admin/departments') return Response.json([{ id: 'dept-1', name: 'Cardiology', code: 'CARD' }]);
      if (path === 'admin/consultation-context-schemas' && method === 'GET') return Response.json([]);
      if (path === 'admin/consultation-context-schemas' && method === 'POST') return Response.json({ id: 'schema-1' });
      if (path === 'admin/consultation-context-schemas/schema-1/publish') return Response.json({ id: 'schema-1', pinnedVersionNumber: 1 });
      if (path === 'admin/agents' && method === 'POST') return Response.json({ id: 'agent-1', slug: 'visit-notes' });
      if (path === 'admin/agents/agent-1/publish') return Response.json({ id: 'agent-1', slug: 'visit-notes' });
      if (path === 'admin/workflow-definitions' && method === 'POST') return Response.json({ id: 'wf-1', slug: 'visit-notes-workflow' });
      if (path === 'admin/workflow-definitions/wf-1/publish') return Response.json({ id: 'wf-1', slug: 'visit-notes-workflow' });
      if (path === 'admin/workflow-assignments' && method === 'POST') return Response.json({ id: 'as-1' });
      return Response.json([]);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndRun() {
  fireEvent.change(screen.getByLabelText('Agent name *'), { target: { value: 'Visit notes' } });
  fireEvent.click(screen.getByLabelText('Model *'));
  fireEvent.click(await screen.findByRole('option', { name: /Gemma 4/ }));
  setTemplateEditorValue(screen.getByRole('textbox', { name: 'System prompt' }), 'Summarise {{context.transcript}}');
  fireEvent.click(screen.getByLabelText('Assign to'));
  fireEvent.click(await screen.findByRole('option', { name: /Cardiology/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create and assign' }));
}

describe('QuickStartBody', () => {
  it('creates schema → agent → workflow → assignment and links each to its editor', async () => {
    const calls = stub();
    renderWithProviders(<QuickStartBody />);
    await fillAndRun();
    const progress = screen.getByRole('list', { name: 'Progress' });
    await waitFor(() => expect(within(progress).getAllByText('Done')).toHaveLength(4));
    expect(within(progress).getByRole('link', { name: /Open the agent/ }).getAttribute('href')).toBe('/agents?slug=visit-notes');
    expect(within(progress).getByRole('link', { name: /Open the workflow/ }).getAttribute('href')).toBe('/workflow-studio/wf-1');

    const posted = calls.filter((call) => call.method === 'POST').map((call) => call.path.replace('/api/hope/', ''));
    expect(posted).toEqual([
      'admin/consultation-context-schemas',
      'admin/consultation-context-schemas/schema-1/publish',
      'admin/agents',
      'admin/agents/agent-1/publish',
      'admin/workflow-definitions',
      'admin/workflow-definitions/wf-1/publish',
      'admin/workflow-assignments',
    ]);
    const agent = calls.find((call) => call.method === 'POST' && call.path.endsWith('admin/agents'));
    expect(agent?.body).toMatchObject({ slug: 'visit-notes', modelId: 'model-1', contextSchemaId: 'schema-1', instruction: { systemPrompt: 'Summarise {{context.transcript}}' } });
    const assignment = calls.find((call) => call.path.endsWith('admin/workflow-assignments'));
    expect(assignment?.body).toMatchObject({ scope: 'DEPARTMENT', scopeId: 'dept-1', workflowDefinitionSlug: 'visit-notes-workflow' });
  });

  it('stops at a refused step and says which', async () => {
    stub('admin/agents');
    renderWithProviders(<QuickStartBody />);
    await fillAndRun();
    const progress = screen.getByRole('list', { name: 'Progress' });
    await waitFor(() => expect(within(progress).getByText(/AGENT_SLUG_TAKEN/)).toBeTruthy());
    expect(within(progress).getAllByText('Done')).toHaveLength(1);
    expect(within(progress).getAllByText('Not started')).toHaveLength(2);
  });

  it('completes the preset schema paths in the prompt editor', async () => {
    stub();
    renderWithProviders(<QuickStartBody />);
    const editor = screen.getByRole('textbox', { name: 'System prompt' });
    setTemplateEditorValue(editor, '{{context.nope}}');
    await waitFor(() => expect(screen.getByText(/`nope` is not declared/)).toBeTruthy(), { timeout: 2000 });
  });

  it('has no axe violations', async () => {
    stub();
    const { container } = renderWithProviders(<QuickStartBody />);
    await screen.findByRole('heading', { level: 1, name: 'Quick start' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
