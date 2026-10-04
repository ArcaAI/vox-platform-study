/**
 * TASK-1036 §3.3 — `/workflow-studio` as a LINEAGE list (OD-13): one row per slug, a versions
 * drawer with per-version verbs, and a client-side bulk bar with per-item results (D-2, OD-14).
 * fetch is stubbed at the network boundary; next/navigation is mocked for the router assertions.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { WorkflowLineage } from '../../../api/types';
import { WorkflowManagementScreen } from '../workflow-management-screen';
import { ALL_DEPRECATED, DISCHARGE_VERSIONS, DRAFT_ONLY, LINEAGES, TRIAGE_VERSIONS, lineage, session, type RecordedCall } from './fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => '/workflow-studio' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Handler = (call: RecordedCall) => Response | undefined;

function stubFetch(custom: Handler = () => undefined, rows: WorkflowLineage[] = LINEAGES): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const override = custom(call);
      if (override) return override;
      const path = new URL(call.url, 'http://test.local').pathname;
      const base = '/api/hope/admin/workflow-definitions';
      if (path === '/api/auth/session') return Response.json(session());
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (call.method === 'GET') {
        if (path === `${base}/lineages`) return Response.json({ count: rows.length, page: 1, limit: 25, data: rows });
        if (path === `${base}/tags`) return Response.json([{ tag: 'dept:cardiology', count: 1 }]);
        if (path === `${base}/d-v2/versions` || path === `${base}/d-v3/versions`) return Response.json(DISCHARGE_VERSIONS);
        if (path === `${base}/t-v1/versions`) return Response.json(TRIAGE_VERSIONS);
        if (path === base) return Response.json({ count: 0, page: 1, limit: 100, data: [] });
        if (path === `${base}/templates`) return Response.json([]);
        if (path.endsWith('/export')) return Response.json({ kind: 'workflow', schemaVersion: 1, exportedAt: 'x', source: { tenantKind: 'tenant', slug: 'discharge', version: 2 }, payload: {} });
        return undefined;
      }
      return Response.json({ id: 'x' });
    }),
  );
  return calls;
}

const urlPath = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname.replace('/api/hope/admin/workflow-definitions', '');

/** Radix menus open on pointerdown, and a previous menu must finish closing before the page is interactive again. */
async function openRowMenu(label: string) {
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  fireEvent.pointerDown(await screen.findByRole('button', { name: `Actions for ${label}` }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

/** Opens the drawer through the `?slug=` deep link: the nuqs testing adapter keeps no URL memory, so a click-opened one would reset on re-sync. */
async function openVersions(slug: string) {
  renderWithProviders(<WorkflowManagementScreen />, { searchParams: `?slug=${slug}` });
  return screen.findByRole('dialog');
}

beforeEach(() => push.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkflowManagementScreen — lineage list', () => {
  it('reads the register and renders ONE row per slug with active version, newest draft, version count, status and assignments; axe clean', async () => {
    const calls = stubFetch();
    const { container } = renderWithProviders(<WorkflowManagementScreen />);

    await screen.findByText('Discharge summary');
    expect(screen.getAllByText('Discharge summary')).toHaveLength(1);
    const grid = screen.getByRole('grid', { name: 'Workflows' });
    const row = within(grid).getByText('discharge').closest('[data-slot="data-grid-row"]') as HTMLElement;
    expect(within(row).getByText('v2')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByText('v3')).toBeTruthy();
    expect(within(row).getByText('Validated')).toBeTruthy();
    expect(within(row).getByText('Tenant default')).toBeTruthy();
    expect(screen.getAllByText('None active')).toHaveLength(2);
    expect(calls.some((call) => call.url.includes('/admin/workflow-definitions/lineages'))).toBe(true);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('row click opens the studio on the active version, else the newest draft; a lineage with neither opens its versions', async () => {
    stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);

    // Clicked on the slug cell: the name itself is a real link now (E4b) and navigates on its own.
    await screen.findByText('Discharge summary');
    fireEvent.click(screen.getByText('discharge'));
    expect(push).toHaveBeenLastCalledWith('/workflow-studio/d-v2');
    fireEvent.click(screen.getByText('triage'));
    expect(push).toHaveBeenLastCalledWith('/workflow-studio/t-v1');
    fireEvent.click(screen.getByText('old-flow'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('with no workflows offers Start from template, New and Import', async () => {
    stubFetch(() => undefined, []);
    renderWithProviders(<WorkflowManagementScreen />);
    expect(await screen.findByText('No workflow definitions yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /start from template/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /new workflow|new definition/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /import/i }).length).toBeGreaterThan(0);
  });

  it('filters rows by tag client-side from the facet', async () => {
    stubFetch();
    renderWithProviders(<WorkflowManagementScreen />, { searchParams: `?f=${encodeURIComponent(JSON.stringify([['tags', 'inArray', 'multiSelect', ['dept:cardiology']]]))}` });
    await screen.findByText('Discharge summary');
    // Only the lineage carrying the tag survives; rows without it are filtered out of the loaded page.
    expect(screen.queryByText('Ward triage')).toBeNull();
  });
});

describe('versions drawer — per-version verbs', () => {
  it('lists the versions and rolls back: Activate names what it demotes, then POSTs /activate', async () => {
    const calls = stubFetch();
    const dialog = await openVersions('discharge');
    await within(dialog).findByText('v1');

    await openRowMenu('v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: /activate/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /^activate/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && urlPath(c) === '/d-v1/activate')).toBe(true));
  });

  it('Edit as new draft on a published version POSTs /draft and opens the new draft; a 409 OPEN_DRAFT_EXISTS opens the existing one', async () => {
    const calls = stubFetch((call) =>
      call.method === 'POST' && call.url.endsWith('/d-v2/draft')
        ? Response.json({ statusCode: 409, message: 'Already has an open draft', error: 'Conflict', code: 'OPEN_DRAFT_EXISTS', draftId: 'd-v3' }, { status: 409 })
        : call.method === 'POST' && call.url.endsWith('/d-v1/draft')
          ? Response.json({ id: 'd-new' })
          : undefined,
    );
    const dialog = await openVersions('discharge');
    await within(dialog).findByText('v1');

    await openRowMenu('v2');
    fireEvent.click(await screen.findByRole('menuitem', { name: /edit as new draft/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-v3'));

    await openRowMenu('v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: /edit as new draft/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-studio/d-new'));
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/draft'))).toHaveLength(2);
  });

  it('Publish is offered on a validated draft with an ok report and POSTs /publish; Unpublish deprecates the published one', async () => {
    const calls = stubFetch();
    const dialog = await openVersions('discharge');
    await within(dialog).findByText('v3');

    await openRowMenu('v3');
    fireEvent.click(await screen.findByRole('menuitem', { name: /^publish/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && urlPath(c) === '/d-v3/publish')).toBe(true));

    await openRowMenu('v1');
    fireEvent.click(await screen.findByRole('menuitem', { name: /unpublish/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /unpublish|deprecate/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && urlPath(c) === '/d-v1/deprecate')).toBe(true));
  });

  it('a draft without a passing stored report cannot be published from the list and says why', async () => {
    stubFetch();
    const dialog = await openVersions('triage');
    await within(dialog).findByText('v1');
    await openRowMenu('v1');
    const item = await screen.findByRole('menuitem', { name: /^publish/i });
    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByText(/validate it in the studio/i)).toBeTruthy();
  });

  it('the active version cannot be deleted; an inactive one is deleted after confirmation', async () => {
    const calls = stubFetch();
    const dialog = await openVersions('discharge');
    await within(dialog).findByText('v1');

    await openRowMenu('v2');
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /^delete/i })).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await openRowMenu('v0');
    fireEvent.click(await screen.findByRole('menuitem', { name: /^delete/i }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: /^delete/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && urlPath(c) === '/d-v0')).toBe(true));
  });
});

describe('bulk bar — client-side per item with per-item results (D-2)', () => {
  async function selectRows(...indexes: number[]) {
    await screen.findByText('Discharge summary');
    const boxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    indexes.forEach((i) => fireEvent.click(boxes[i]));
    return screen.findByRole('toolbar', { name: 'Bulk actions' });
  }

  it('Unpublish deprecates each active version and reports the lineage that has none', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0, 1);
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: /unpublish/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^unpublish/i }));
    const results = await screen.findByRole('dialog', { name: /unpublish/i });
    await within(results).findByText(/no active version/i);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/deprecate')).map(urlPath)).toEqual(['/d-v2/deprecate']);
    expect(within(results).getByText(/1 of 2 failed|1 failed/i)).toBeTruthy();
  });

  it('Publish takes each lineage’s newest VALIDATED draft and skips one that has none', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0, 1);
    fireEvent.click(within(bar).getByRole('button', { name: /^publish/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^publish/i }));
    const results = await screen.findByRole('dialog', { name: /publish/i });
    await within(results).findByText(/no validated draft/i);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/publish')).map(urlPath)).toEqual(['/d-v3/publish']);
  });

  it('Export downloads one bundle per lineage', async () => {
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => { created.push('blob'); return 'blob:x'; }), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0, 1);
    fireEvent.click(within(bar).getByRole('button', { name: /export/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /download 2 files/i }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/export')).map(urlPath).sort()).toEqual(['/d-v2/export', '/t-v1/export']);
    click.mockRestore();
  });

  it('Delete all versions needs the typed slug, deprecates the active version first, then deletes every version', async () => {
    const calls = stubFetch();
    renderWithProviders(<WorkflowManagementScreen />);
    const bar = await selectRows(0);
    fireEvent.click(within(bar).getByRole('button', { name: /delete all versions/i }));
    const confirm = await screen.findByRole('alertdialog');
    const go = within(confirm).getByRole('button', { name: /delete all versions/i }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(confirm).getByRole('textbox'), { target: { value: 'discharge' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);

    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(4));
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${urlPath(c)}`);
    expect(writes[0]).toBe('POST /d-v2/deprecate');
    expect(writes.slice(1).sort()).toEqual(['DELETE /d-v0', 'DELETE /d-v1', 'DELETE /d-v2', 'DELETE /d-v3']);
  });
});

describe('guards on the fixtures', () => {
  it('fixtures stay consistent', () => {
    expect(lineage().active?.id).toBe('d-v2');
    expect(DRAFT_ONLY.active).toBeNull();
    expect(ALL_DEPRECATED.draft).toBeNull();
  });
});
