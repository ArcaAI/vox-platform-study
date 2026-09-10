/**
 * TASK-947 §4.5 item 5 — the agent detail drawer's composite-agent surfaces: a PUBLISHED
 * composite agent renders a read-only fragment summary (key, source, condition) instead of the
 * raw JSON block; a DRAFT composite agent seeds the fragments editor from its own instruction and
 * PATCHes the edited fragments back. `fetch` is stubbed at the network boundary, mirroring
 * `agent-detail.task890.test.tsx`.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { AgentDetailDrawer } from '../agent-detail';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const FRAGMENTS_INSTRUCTION = {
  fragments: [
    { key: 'base', promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
    { key: 'revisit', promptTemplateId: 'tpl-1', when: "has(context.visit_type) && context.visit_type == 'revisit'" },
  ],
};

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
    instruction: FRAGMENTS_INSTRUCTION,
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

const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 3, currentVersionNumber: 3, contentPreview: 'Write a note', declaredVariables: [] };

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
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json({ providers: [], models: [] });
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

describe('AgentDetailDrawer — composite instruction (TASK-947)', () => {
  it('a PUBLISHED composite agent shows a read-only fragment summary, not the raw JSON block', async () => {
    stubFetch(agent({ status: 'PUBLISHED', isActive: true, publishedAt: '2026-09-02T10:00:00.000Z' }));
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Configuration' }), { button: 0 });
    expect(await screen.findByText('Instruction — composable fragments (2)')).toBeTruthy();
    expect(screen.getByText('base')).toBeTruthy();
    expect(screen.getByText('revisit')).toBeTruthy();
    expect(screen.getByText('Base — always included')).toBeTruthy();
    expect(screen.getByText(/when: has\(context\.visit_type\)/)).toBeTruthy();
    expect(screen.queryByText('Instruction')).toBeNull();
  });

  it('a DRAFT composite agent seeds the fragments editor, and saving PATCHes the edited fragments', async () => {
    const calls = stubFetch(agent(), (call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1')) return Response.json({ ...agent(), version: 2 }, { headers: { etag: '"2"' } });
      return undefined;
    });
    renderWithProviders(<AgentDetailDrawer agentId="a-1" onOpenChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Configuration' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));

    // Seeded into fragments mode with both rows present.
    const fragmentsRadio = (await screen.findByLabelText('Composable fragments (conditional)')) as HTMLInputElement;
    expect(fragmentsRadio.getAttribute('data-state')).toBe('checked');
    const keyInputs = screen.getAllByLabelText('Key *') as HTMLInputElement[];
    expect(keyInputs.map((input) => input.value)).toEqual(['base', 'revisit']);

    // Edit the revisit fragment's key and save.
    fireEvent.change(keyInputs[1], { target: { value: 'revisit2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'))).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/agents/a-1'));
    const patchedInstruction = (patch?.body as { instruction: typeof FRAGMENTS_INSTRUCTION }).instruction;
    expect(patchedInstruction.fragments.map((fragment) => fragment.key)).toEqual(['base', 'revisit2']);
    expect(patchedInstruction.fragments[0]).toEqual(FRAGMENTS_INSTRUCTION.fragments[0]);
  });
});
