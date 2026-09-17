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
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '../../api/types';
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

/**
 * TASK-965 WS-4 — the grid reads the LINEAGE register, so the rows above fold into three
 * lineages. The tags travel on the lineage row exactly as they did on the version row.
 */
const LINEAGES: AgentLineage[] = AGENTS.map((row) => ({
  slug: row.slug,
  name: row.name,
  task: row.task,
  versionCount: 1,
  latestVersionNumber: row.versionNumber,
  deprecatedCount: 0,
  active: { id: row.id, versionNumber: row.versionNumber, publishedAt: row.publishedAt, publishedBy: null, modelSlug: row.modelSlug, compiledConfigChecksum: row.compiledConfigChecksum },
  draft: null,
  assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
  origin: { sourceTenantId: row.sourceTenantId, sourceSlug: row.sourceSlug },
  tags: row.tags,
  updatedAt: row.updatedAt,
  hidden: false,
}));

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
      if (path === '/api/hope/admin/agents/lineages') {
        const params = new URL(call.url, 'http://test.local').searchParams;
        const slug = /slug\[iequals\]:([^;]+)/.exec(params.get('filters') ?? '')?.[1];
        const data = LINEAGES.filter((row) => !slug || row.slug === slug);
        return Response.json({ count: data.length, page: 1, limit: 25, data });
      }
      if (path === '/api/hope/admin/agents') return Response.json(AGENTS);
      {
        const row = AGENTS.find((candidate) => path === `/api/hope/admin/agents/${candidate.id}`);
        if (row) return Response.json(row, { headers: { etag: `"${row.version}"` } });
      }
      if (path.endsWith('/versions')) return Response.json([AGENTS[0]]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
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

  /**
   * TASK-965 WS-4 — the tag FACET is gone, and its absence is deliberate.
   *
   * `GET admin/agents/lineages` applies `filters` to the VERSION ROWS and folds afterwards
   * (`AgentRepository.findLineagesForTenant`), so a predicate that can differ between the versions
   * of one slug — and `tags` is per version, editable on every draft — would not merely narrow the
   * list: it would drop rows from the fold and rewrite the lineage's own `active`, `draft`,
   * `versionCount` and `deprecatedCount`. A lineage whose active v2 is untagged would answer
   * "None active" under a tag filter, which is the exact class of lie this ticket exists to
   * remove. Until the register can narrow by tag AFTER the fold, the console shows the tags and
   * offers no facet over them. `task` is the one fold-safe facet (it is constant across a
   * lineage), which is why it is a first-class field on the route.
   */
  it('shows each lineage’s tags but offers no tag facet: a stale `f` tags rule narrows nothing and corrupts nothing', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: tagFilter('specialty:rheumatology') });
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    // Every lineage is still listed, with its own counters intact — no silent fold distortion.
    expect(screen.getByText('Clinic general')).toBeTruthy();
    expect(screen.getByText('Platform summarization')).toBeTruthy();
    expect(screen.getByText('3 of 3 agents')).toBeTruthy();
  });

  it('never sends a tag predicate to the register, even when the URL carries one', async () => {
    const calls = stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: tagFilter('specialty:rheumatology', 'tier:platform-default') });
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    const register = calls.filter((call) => call.url.includes('/admin/agents/lineages'));
    expect(register.length).toBeGreaterThan(0);
    expect(register.every((call) => !call.url.includes('tags'))).toBe(true);
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

    renderWithProviders(<AgentsScreen />, { searchParams: '?slug=clinic-summarizer' });
    const exportButton = await screen.findByRole('button', { name: 'Export v2' });
    fireEvent.click(exportButton);

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes('/clinic-summarizer/export'));
      expect(call).toBeTruthy();
      // The INSPECTED version — the active one by default, since that is what the lineage serves.
      expect(call?.url).toContain('versionNumber=2');
    });
  });

  it('sends the parsed selectorTags with the assignment, and refuses a bare key before the request', async () => {
    const calls = stubFetch((call) => {
      const path = new URL(call.url, 'http://test.local').pathname;
      if (call.method === 'POST' && path === '/api/hope/admin/agent-assignments') return Response.json({ id: 'as-1' }, { status: 201 });
      return undefined;
    });
    renderWithProviders(<AgentsScreen />, { searchParams: '?slug=clinic-summarizer' });

    // TASK-965 WS-4 — assignment is per SLUG, so it lives on the lineage's Assignments tab.
    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });
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
    renderWithProviders(<AgentsScreen />, { searchParams: '?slug=clinic-summarizer' });

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Set as tenant default' }));
    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/admin/agent-assignments'));
      expect(post?.body).toBeTruthy();
      expect(post?.body).not.toHaveProperty('selectorTags');
    });
  });
});
