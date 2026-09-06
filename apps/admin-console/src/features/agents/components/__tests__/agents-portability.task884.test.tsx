/**
 * TASK-884 — the console surfaces of the agent capabilities: the tag filter on the list, the
 * import action on the list, the export button on the detail, and the tag selector in the
 * assignment editor. fetch is stubbed at the network boundary, as in `agents-screen.test.tsx`.
 *
 * What is deliberately NOT asserted here: whether a bundle is valid, whether its references
 * resolve, or which assignment row a selector addresses. Those are the gateway's answers, proven
 * in `packages/applications/src/services/agent/__tests__/agent.portability.task884.test.ts`; a
 * second, weaker copy in the browser would be a rule with two owners.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 2,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'PUBLISHED',
    isActive: true,
    modelId: 'm-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    fallbacks: [],
    instruction: { systemPrompt: 'You are a scribe.' },
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: { task: 'TEXT_GENERATION' },
    compiledConfigChecksum: 'sha256:abc',
    validationReport: null,
    validatedAt: null,
    publishedAt: '2026-09-02T10:00:00.000Z',
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: ['tier:tenant', 'specialty:rheumatology'],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 3,
    ...overrides,
  };
}

// TASK-890 OD-M — sys-1 is THIS tenant's own CLONE of a platform template (`sourceTenantId`
// names the origin), not a live SYSTEM row: `GET admin/agents` never returns `tenantId ===
// SYSTEM` to a tenant caller. The tag content itself is what these tests actually exercise.
const AGENTS: Agent[] = [
  agent(),
  agent({ id: 'a-2', slug: 'clinic-general', name: 'Clinic general', tags: ['tier:tenant', 'specialty:general'] }),
  agent({ id: 'sys-1', sourceTenantId: SYSTEM, sourceSlug: 'platform-summarization', slug: 'clinic-platform-summarization', name: 'Platform summarization', tags: ['tier:platform-default', 'task:llm'] }),
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(extra: (call: RecordedCall) => Response | undefined = () => undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const custom = extra(call);
      if (custom) return custom;
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (path === '/api/auth/session') {
        const user = { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] };
        return Response.json({
          user,
          isElevated: true,
          workingTenantId: 'tnt-1',
          workingTenantName: 'Sunrise Medical Group',
          impersonatingUserId: null,
          impersonatingUsername: null,
          effectiveUser: { ...user, tenantId: null, departmentId: null },
          effectiveIsElevated: true,
          effectiveTenantId: 'tnt-1',
        });
      }
      if (call.method !== 'GET') throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      if (path === '/api/hope/admin/agents') return Response.json(AGENTS);
      if (path === '/api/hope/admin/agents/a-1') return Response.json(AGENTS[0], { headers: { etag: '"3"' } });
      if (path.endsWith('/versions')) return Response.json([AGENTS[0]]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json({ providers: [], models: [] });
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [] });
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Agents list — tags', () => {
  it('renders each agent’s key:value tags', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />);
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    expect(screen.getAllByText('specialty:rheumatology').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('tier:platform-default').length).toBeGreaterThanOrEqual(1);
  });

  /** The grid's URL codec: one `f` param holding positional `[id, operator, variant, value]` tuples. */
  function tagFilter(...values: string[]): string {
    return `?f=${encodeURIComponent(JSON.stringify([['tags', 'inArray', 'multiSelect', values]]))}`;
  }

  it('filters to the agents carrying a selected tag, from the URL filter state', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: tagFilter('specialty:rheumatology') });
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    expect(screen.queryByText('Clinic general')).toBeNull();
    expect(screen.queryByText('Platform summarization')).toBeNull();
  });

  // AND-joined, matching how a selector narrows the assignment cascade. The footer count is
  // asserted rather than only absence, so the test cannot pass on a render that has not loaded.
  it('AND-joins several tags rather than widening to either', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: tagFilter('specialty:rheumatology', 'tier:platform-default') });
    expect(await screen.findByText('0 of 3 shown')).toBeTruthy();
    expect(screen.queryByText('Clinic summarizer')).toBeNull();
    expect(screen.queryByText('Platform summarization')).toBeNull();
  });
});

describe('Agents list — import', () => {
  it('POSTs the parsed file to admin/agents/import and opens the created draft', async () => {
    const created = agent({ id: 'imported-1', slug: 'imported', name: 'Imported notes', status: 'DRAFT', isActive: false, versionNumber: 1 });
    const calls = stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'POST' && path === '/api/hope/admin/agents/import') return Response.json(created, { status: 201 });
      if (path === '/api/hope/admin/agents/imported-1') return Response.json(created, { headers: { etag: '"1"' } });
      return undefined;
    });
    renderWithProviders(<AgentsScreen />);
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();

    const bundle = { kind: 'agent', schemaVersion: 1, exportedAt: '2026-09-06T00:00:00.000Z', source: { tenantKind: 'tenant', slug: 'imported', version: 1 }, payload: { slug: 'imported' } };
    const input = screen.getByLabelText('Agent bundle to import') as HTMLInputElement;
    const file = new File([JSON.stringify(bundle)], 'agent.json', { type: 'application/json' });
    // happy-dom's File does not implement `text()`; the component only needs that one method.
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(bundle) });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/admin/agents/import'));
      expect(post?.body).toEqual({ bundle });
    });
  });

  it('never reaches the gateway when the file is not JSON', async () => {
    const calls = stubFetch();
    renderWithProviders(<AgentsScreen />);
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();

    const input = screen.getByLabelText('Agent bundle to import') as HTMLInputElement;
    const file = new File(['not json'], 'agent.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => 'not json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(calls.some((call) => call.url.includes('/admin/agents/import'))).toBe(false));
  });
});

describe('Agent detail — export and the assignment tag selector', () => {
  it('GETs the bundle for the OPEN VERSION and hands it to the browser to save', async () => {
    const bundle = { kind: 'agent', schemaVersion: 1, exportedAt: '2026-09-06T00:00:00.000Z', source: { tenantKind: 'tenant', slug: 'clinic-summarizer', version: 2 }, payload: { slug: 'clinic-summarizer', notes: [] } };
    const calls = stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (path === '/api/hope/admin/agents/clinic-summarizer/export') return Response.json(bundle);
      return undefined;
    });
    // happy-dom has no object-URL implementation; the click is what we are asserting on.
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));

    renderWithProviders(<AgentsScreen />, { searchParams: '?agent=a-1' });
    const exportButton = await screen.findByRole('button', { name: 'Export' });
    fireEvent.click(exportButton);

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes('/clinic-summarizer/export'));
      expect(call).toBeTruthy();
      // The OPEN version, not "whatever is active" — the drawer shows one row and exports it.
      expect(call?.url).toContain('versionNumber=2');
    });
  });

  it('sends the parsed selectorTags with the assignment, and refuses a bare key before the request', async () => {
    const calls = stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'POST' && path === '/api/hope/admin/agent-assignments') return Response.json({ id: 'as-1' }, { status: 201 });
      return undefined;
    });
    renderWithProviders(<AgentsScreen />, { searchParams: '?agent=a-1' });

    const selector = await screen.findByLabelText('Tag selector (optional)');

    // A bare key is named back to the user and the button is disabled — no request is made.
    fireEvent.change(selector, { target: { value: 'rheumatology' } });
    expect(screen.getByText(/is not a key:value tag/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Assign for these tags|Set as tenant default/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(selector, { target: { value: 'specialty:rheumatology, lang:ml' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign for these tags' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/admin/agent-assignments'));
      expect(post?.body).toMatchObject({ scope: 'TENANT', task: 'TEXT_GENERATION', agentSlug: 'clinic-summarizer', selectorTags: ['lang:ml', 'specialty:rheumatology'] });
    });
  });

  it('omits selectorTags entirely when the box is empty — that is the tier’s unqualified assignment', async () => {
    const calls = stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'POST' && path === '/api/hope/admin/agent-assignments') return Response.json({ id: 'as-1' }, { status: 201 });
      return undefined;
    });
    renderWithProviders(<AgentsScreen />, { searchParams: '?agent=a-1' });

    fireEvent.click(await screen.findByRole('button', { name: 'Set as tenant default' }));
    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/admin/agent-assignments'));
      expect(post?.body).toBeTruthy();
      expect(post?.body).not.toHaveProperty('selectorTags');
    });
  });
});
