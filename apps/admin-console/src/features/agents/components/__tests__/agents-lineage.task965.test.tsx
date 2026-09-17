/**
 * TASK-965 WS-4 — the Agents screen on the LINEAGE model.
 *
 * The reported symptom, in the owner's words: *"still seeing duplicated entries for different
 * versions (Realtime transcription v2 Published Active / v1 Deprecated) — very bad UX as admins
 * will create more versions."* The grid read `GET admin/agents`, which answers one row per
 * VERSION; these cases pin the fix at the level the defect lived — one row per SLUG, with the
 * active pointer, the open draft, the version count and what the slug serves ON that row, and the
 * versions one level down in the drawer where Activate can move the pointer back (OD-965-1).
 *
 * fetch is stubbed at the network boundary, as in every other screen test in this feature.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function lineage(overrides: Partial<AgentLineage> = {}): AgentLineage {
  return {
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    task: 'SPEECH_TO_TEXT',
    versionCount: 3,
    latestVersionNumber: 3,
    deprecatedCount: 1,
    active: {
      id: 'rt-v2',
      versionNumber: 2,
      publishedAt: '2026-09-02T10:15:00.000Z',
      publishedBy: 'u-publisher',
      modelSlug: 'arcaai-whisper-large-ml-en-gguf',
      compiledConfigChecksum: 'sha256:abc',
    },
    draft: { id: 'rt-v3', versionNumber: 3, status: 'DRAFT', updatedAt: '2026-09-05T09:00:00.000Z' },
    assignment: { tenantDefault: true, departmentCount: 2, selectorCount: 0 },
    origin: { sourceTenantId: SYSTEM, sourceSlug: 'realtime-transcription' },
    tags: ['domain:clinical'],
    updatedAt: '2026-09-05T09:00:00.000Z',
    hidden: false,
    ...overrides,
  };
}

/** A lineage with published versions but NONE active, and nothing assigned to it. */
const ORPHANED = lineage({
  slug: 'ward-triage',
  name: 'Ward triage',
  task: 'TEXT_GENERATION',
  versionCount: 2,
  latestVersionNumber: 2,
  deprecatedCount: 0,
  active: null,
  draft: null,
  assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
  origin: { sourceTenantId: null, sourceSlug: null },
  tags: [],
});

const HIDDEN = lineage({
  slug: 'dna-writing-style-analyst',
  name: 'DNA writing style analyst',
  task: 'TEXT_GENERATION',
  versionCount: 1,
  latestVersionNumber: 1,
  deprecatedCount: 0,
  active: { id: 'dna-v1', versionNumber: 1, publishedAt: '2026-09-01T10:00:00.000Z', publishedBy: null, modelSlug: 'lms-gemma', compiledConfigChecksum: null },
  draft: null,
  assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
  origin: { sourceTenantId: SYSTEM, sourceSlug: 'dna-writing-style-analyst' },
  tags: [],
  hidden: true,
});

const LINEAGES = [lineage(), HIDDEN, ORPHANED];

function version(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'rt-v2',
    tenantId: 'tnt-1',
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    description: null,
    task: 'SPEECH_TO_TEXT',
    versionNumber: 2,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: SYSTEM,
    sourceSlug: 'realtime-transcription',
    sourceVersionNumber: 1,
    status: 'PUBLISHED',
    isActive: true,
    modelId: 'm-asr',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'arcaai-whisper-large-ml-en-gguf',
    fallbacks: [],
    instruction: null,
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: { task: 'SPEECH_TO_TEXT' },
    compiledConfigChecksum: 'sha256:abc',
    validationReport: null,
    validatedAt: null,
    publishedAt: '2026-09-02T10:15:00.000Z',
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: ['domain:clinical'],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:15:00.000Z',
    createdBy: null,
    updatedBy: 'u-publisher',
    version: 4,
    ...overrides,
  };
}

/** v3 DRAFT · v2 PUBLISHED+active · v1 PUBLISHED but NOT active — the rollback candidate. */
const RT_VERSIONS: Agent[] = [
  version({ id: 'rt-v3', versionNumber: 3, status: 'DRAFT', isActive: false, publishedAt: null, compiledConfig: null, compiledConfigChecksum: null, updatedAt: '2026-09-05T09:00:00.000Z' }),
  version(),
  version({ id: 'rt-v1', versionNumber: 1, status: 'PUBLISHED', isActive: false, publishedAt: '2026-08-01T10:00:00.000Z', compiledConfigChecksum: 'sha256:old' }),
];

const CATALOGUE = {
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 1 }],
  models: [
    { id: 'm-asr', slug: 'arcaai-whisper-large-ml-en-gguf', name: 'Whisper ML/EN', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', providerId: 'hope', provider: 'built-in', providerClass: 'platform-self-host', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function session() {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Global',
    impersonatingUserId: null,
    impersonatingUsername: null,
  };
  return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: true, effectiveTenantId: 'tnt-1' };
}

function stubFetch(custom: FetchHandler = () => undefined, rows: AgentLineage[] = LINEAGES): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const custom_ = custom(call);
      if (custom_) return custom_;

      const url = new URL(call.url, 'http://test.local');
      const path = url.pathname;
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (call.method !== 'GET') return undefined;
      if (path === '/api/auth/session') return Response.json(session());
      if (path === '/api/hope/admin/agents/lineages') {
        // The register narrows by `?task=` and by the fold-safe `slug[iequals]` filter; both are
        // applied here so a facet/deep-link assertion sees what the gateway would answer.
        const task = url.searchParams.get('task');
        const filters = url.searchParams.get('filters') ?? '';
        const slug = /slug\[iequals\]:([^;]+)/.exec(filters)?.[1];
        // A slug filter is the drawer's deep-link resolver: it addresses the whole register, not
        // just the page the grid happens to hold, which is the case the resolver exists for.
        const source = slug ? LINEAGES : rows;
        const data = source.filter((row) => (!task || row.task === task) && (!slug || row.slug === slug));
        return Response.json({ count: data.length, page: 1, limit: 25, data });
      }
      const detail = RT_VERSIONS.find((row) => path === `/api/hope/admin/agents/${row.id}`);
      if (detail) return Response.json(detail, { headers: { etag: `"${detail.version}"` } });
      if (path === '/api/hope/admin/agents/dna-v1') return Response.json(version({ id: 'dna-v1', slug: 'dna-writing-style-analyst', name: 'DNA writing style analyst', task: 'TEXT_GENERATION', versionNumber: 1 }), { headers: { etag: '"1"' } });
      if (RT_VERSIONS.some((row) => path === `/api/hope/admin/agents/${row.id}/versions`)) return Response.json(RT_VERSIONS);
      if (path.endsWith('/versions')) return Response.json([]);
      if (path === '/api/hope/admin/agents') return Response.json([]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [] });
      return undefined;
    }),
  );
  return calls;
}

/** Radix menus open on pointerdown, not click (the console's own row-menu test helper). */
function openRowMenu(versionLabel: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${versionLabel}` }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

async function openDrawer(name: string) {
  fireEvent.click(await screen.findByText(name));
  return screen.findByRole('dialog');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsScreen — one row per lineage (TASK-965 WS-4, AG-13/AG-14)', () => {
  it('reads the lineage register and renders ONE row per slug, carrying the active version, the open draft, the version count and what it serves', async () => {
    const calls = stubFetch();
    renderWithProviders(<AgentsScreen />);

    await screen.findByText('Realtime transcription');
    // The defect, literally: three versions of one slug used to be three rows.
    expect(screen.getAllByText('Realtime transcription')).toHaveLength(1);
    expect(screen.getByText('realtime-transcription')).toBeTruthy();

    const grid = screen.getByRole('grid', { name: 'Agents' });
    const row = within(grid).getByText('realtime-transcription').closest('[data-slot="data-grid-row"]') as HTMLElement;
    expect(within(row).getByText('v2')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByText('v3')).toBeTruthy();
    expect(within(row).getByText('Draft')).toBeTruthy();
    expect(within(row).getByText('Tenant default')).toBeTruthy();
    expect(within(row).getByText('2 departments')).toBeTruthy();
    expect(within(row).getByText('Platform origin')).toBeTruthy();

    // The count in the header counts AGENTS, never version rows (AG-14).
    expect(screen.getByText('3 agents · 6 versions on this page')).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/admin/agents/lineages'))).toBe(true);
    // The per-version list is not what the grid reads any more.
    expect(calls.some((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/agents')).toBe(false);
  });

  it('a lineage with no active version says so, and one nothing assigns says Unassigned rather than claiming a platform default (AG-3)', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />);

    await screen.findByText('Ward triage');
    const grid = screen.getByRole('grid', { name: 'Agents' });
    const row = within(grid).getByText('ward-triage').closest('[data-slot="data-grid-row"]') as HTMLElement;
    expect(within(row).getByText('None active')).toBeTruthy();
    expect(within(row).getByText('Unassigned')).toBeTruthy();
  });

  it('flags the platform service agent and offers it no tenant verbs (TASK-974 D-1)', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />);
    await screen.findByText('DNA writing style analyst');
    expect(screen.getAllByText('Hidden · platform')).toHaveLength(1);

    const drawer = await openDrawer('DNA writing style analyst');
    expect(await within(drawer).findByText(/Platform service agent/)).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /New draft/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /^Publish$/ })).toBeNull();
  });
});

describe('AgentsScreen — the lineage drawer (TASK-965 WS-4)', () => {
  it('opens from a `?slug=` deep link, even for a lineage that is not on the loaded page (AG-21)', async () => {
    // Only the hidden lineage is on the page; the deep link names another, so the drawer has to
    // resolve it through the register itself rather than showing an empty shell.
    const calls = stubFetch(() => undefined, [HIDDEN]);
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Realtime transcription')).toBeTruthy();
    expect(within(drawer).getByText(/realtime-transcription · 3 versions · serving v2 · draft v3/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes('slug%5Biequals%5D%3Arealtime-transcription'))).toBe(true);
  });

  it('translates the old `?agent=<version id>` link into `?slug=`, so a shared link keeps working for one release (AG-21)', async () => {
    const onUrlUpdate = vi.fn();
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: 'agent=rt-v2', onUrlUpdate });

    await waitFor(() => {
      const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
      expect(last.searchParams.get('slug')).toBe('realtime-transcription');
      expect(last.searchParams.get('agent')).toBeNull();
    });
  });

  it('lists every version of the lineage with its status and the active marker (AG-18)', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });
    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Versions' }), { button: 0 });

    const list = await within(drawer).findByRole('list', { name: 'Versions of realtime-transcription' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByTestId('version-number').textContent)).toEqual(['v3', 'v2', 'v1']);
    expect(within(rows[1]).getByText('Active')).toBeTruthy();
    expect(within(rows[2]).queryByText('Active')).toBeNull();
  });

  it('activating an older published version names what it demotes, POSTs to /activate and refetches the register (OD-965-1 / AG-2)', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/rt-v1/activate')) {
        return Response.json(version({ id: 'rt-v1', versionNumber: 1, isActive: true }));
      }
      return undefined;
    });
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });
    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Versions' }), { button: 0 });
    await within(drawer).findByRole('list', { name: 'Versions of realtime-transcription' });

    openRowMenu('v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Activate v1' }));

    const confirm = await screen.findByRole('alertdialog');
    // The consequence, not "are you sure": what becomes active, what stops serving, who follows.
    expect(confirm.textContent).toMatch(/v1 becomes the active version/);
    expect(confirm.textContent).toMatch(/v2 stops serving/);
    expect(confirm.textContent).toMatch(/2 department assignments name this slug and move with it/);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Activate v1' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/admin/agents/rt-v1/activate'))).toBe(true));
    // An activation demotes a sibling server-side, so the register must be read again.
    const registerReads = calls.filter((call) => call.url.includes('/admin/agents/lineages'));
    await waitFor(() => expect(registerReads.length).toBeGreaterThanOrEqual(1));
    expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/activate'))?.body).toEqual({});
  });

  it('“Activate” is not offered on the version that is already active', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });
    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Versions' }), { button: 0 });
    await within(drawer).findByRole('list', { name: 'Versions of realtime-transcription' });

    openRowMenu('v2');
    const item = await screen.findByRole('menuitem', { name: /Activate v2/ });
    expect(item.getAttribute('data-disabled')).not.toBeNull();
    expect(item.textContent).toMatch(/Already the version this slug serves/);
  });

  it('resets its transient state when the selection moves to another lineage (AG-1 at lineage scope)', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Edit draft' }));
    const name = (await within(drawer).findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Half-typed rename' } });

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    const next = await openDrawer('Ward triage');
    await within(next).findByText('Ward triage');
    // The other lineage has no open draft at all, so a surviving form would be unmistakable.
    expect(within(next).queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByDisplayValue('Half-typed rename')).toBeNull();
  });

  it('offers "New draft" only where there is no open draft (OD-965-9 / AG-19)', async () => {
    stubFetch();
    renderWithProviders(<AgentsScreen />, { searchParams: 'slug=realtime-transcription' });
    const drawer = await screen.findByRole('dialog');
    // A draft is open on this lineage: the footer continues it (Validate/Publish), never mints another.
    expect(await within(drawer).findByRole('button', { name: /^Validate$/ })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'New draft' })).toBeNull();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    const next = await openDrawer('Ward triage');
    expect(await within(next).findByRole('button', { name: 'New draft' })).toBeTruthy();
    expect(within(next).queryByRole('button', { name: /^Publish$/ })).toBeNull();
  });

  it('has no axe violations on the loaded grid, nor inside the open lineage drawer (WCAG 2.2 AA gate)', async () => {
    stubFetch();
    const { container } = renderWithProviders(<AgentsScreen />);
    await screen.findByText('Realtime transcription');
    // The page with the drawer CLOSED: a Radix sheet marks everything behind it aria-hidden,
    // which axe (correctly) flags as hidden-but-focusable if scanned together.
    expect(await axe(container)).toHaveNoViolations();

    const drawer = await openDrawer('Realtime transcription');
    await within(drawer).findByRole('tab', { name: 'Versions' });
    expect(await axe(drawer)).toHaveNoViolations();
  });
});
