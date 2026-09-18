/**
 * Frame 20 — Users list screen (AdminDataGrid). fetch is stubbed at the network
 * boundary; assertions here are the rendered list states, the request the typed
 * filters produce (the NEW gateway BRACKET grammar `field[op]:value` joined by
 * `;`), grid selection + bulk actions, CSV export, and the create POST.
 *
 * The grid persists per-user layout via `GET users/me/settings`, so `settingsResponse`
 * answers it and assertions locate the list request by URL rather than call index.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { User, UserRoleAssignment } from '../../api/types';
import { UsersListScreen } from '../users-list-screen';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function roleAssignment(overrides: Partial<UserRoleAssignment> = {}): UserRoleAssignment {
  return {
    id: 'ra-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    userId: 'u-1',
    roleId: 'role-clinician',
    roleName: 'Clinician',
    tenantId: 't-1',
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u-1',
    projectId: null,
    createdAt: '2025-06-01T10:00:00.000Z',
    updatedAt: '2025-06-28T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    username: 'mia.okafor',
    lastLoginAt: '2025-06-30T09:12:00.000Z',
    lastActiveAt: '2025-06-30T10:00:00.000Z',
    isServiceAccount: false,
    UserRoleAssignments: [roleAssignment()],
    ...overrides,
  };
}

const USERS = [
  user(),
  user({
    id: 'u-2',
    username: 'jonas.weber',
    resourceStatus: 'DISABLED',
    isServiceAccount: true,
    UserRoleAssignments: [],
    lastActiveAt: undefined,
  }),
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Best-effort per-user grid-layout persistence (`users/me/settings`) — no saved layout in tests. */
function settingsResponse(url: string, init?: RequestInit): Response | undefined {
  if (!url.includes('/users/me/settings')) return undefined;
  return (init?.method ?? 'GET') === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const response = handler(url, init);
      if (!response) throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
      return response;
    }),
  );
  return calls;
}

function listResponse(rows: User[]): Response {
  return Response.json({ data: rows, count: rows.length, limit: 25, page: 0 });
}

/** Happy-path handlers for the list plus the row/bulk mutations; overrides win. */
function stubListFetch(overrides?: (url: string, init?: RequestInit) => Response | undefined): RecordedCall[] {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    const custom = overrides?.(url, init);
    if (custom) return custom;
    const settings = settingsResponse(url, init);
    if (settings) return settings;
    // Role + department catalogs behind the create dialog's mandatory
    // membership pickers (TASK-983 R6).
    if (method === 'GET' && url.startsWith('/api/hope/admin/rbac/roles')) {
      return Response.json({ data: [{ id: 'role-clinician', name: 'Clinician' }] });
    }
    if (method === 'GET' && url.startsWith('/api/hope/admin/departments')) {
      return Response.json([{ id: 'dept-gen', code: 'GEN', name: 'General Medicine' }]);
    }
    // Tenant catalog behind the Tenant column/filter.
    if (method === 'GET' && url.startsWith('/api/hope/admin/tenants')) {
      return Response.json({ data: [{ id: 't-1', name: 'Acme Hospital', key: 'acme' }], count: 1, limit: 500, page: 0 });
    }
    if (method === 'GET' && url.startsWith('/api/hope/admin/users/tenant/')) return listResponse([USERS[0]]);
    if (method === 'GET' && url.startsWith('/api/hope/admin/users?')) return listResponse(USERS);
    if (method === 'PATCH' && url === '/api/hope/admin/users/u-1/status') return Response.json(user({ resourceStatus: 'DISABLED' }));
    if (method === 'DELETE' && url === '/api/hope/admin/users/u-1') return Response.json(user());
    if (method === 'POST' && url === '/api/hope/admin/users/bulk-actions') {
      return Response.json({ action: 'disable', total: 2, succeeded: 2, failed: 0, results: [] });
    }
    if (method === 'POST' && url === '/api/hope/admin/users/u-1/reset-password') {
      return Response.json({ mode: 'link', token: 'tok-1', resetPath: '/reset-password?token=tok-1', emailSent: false });
    }
    if (method === 'POST' && url === '/api/hope/admin/users') return Response.json(user({ id: 'u-new', username: 'anna' }));
    return undefined;
  });
}

/** The gateway list request (skips the interleaved `users/me/settings` layout GET). */
function listCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((entry) => entry.method === 'GET' && entry.url.includes('/admin/users?'));
  if (!call) throw new Error('no /admin/users GET recorded');
  return call;
}

/** Query params without relying on the global `URL` (the export test stubs it). */
function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '');
}

/** Radix Select: open the trigger and click an option by its label. */
async function pickOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function openRowMenu(username: string) {
  const trigger = screen.getByRole('button', { name: new RegExp(`open actions for ${username}`, 'i') });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockClear();
  cleanup();
});

describe('UsersListScreen', () => {
  it('renders user rows with roles, status and type from the list payload', async () => {
    stubListFetch();
    renderWithProviders(<UsersListScreen />);

    expect(await screen.findByText('mia.okafor')).toBeDefined();
    expect(screen.getByText('jonas.weber')).toBeDefined();
    expect(screen.getByText('Clinician')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();
    expect(screen.getByText('Service account')).toBeDefined();
    expect(screen.getByText(/2 users/i)).toBeDefined();
  });

  it('renders the role chips on a single line so the fixed-height row keeps its border', async () => {
    stubListFetch();
    renderWithProviders(<UsersListScreen />);

    const chip = await screen.findByText('Clinician');
    // A wrapping container grows past the fixed-height virtual row and paints over border-b.
    expect((chip.parentElement as HTMLElement).className).not.toContain('flex-wrap');
  });

  it('shows the no-users empty state with a create CTA when the list is empty', async () => {
    stubListFetch((url) => (url.startsWith('/api/hope/admin/users?') ? listResponse([]) : undefined));
    renderWithProviders(<UsersListScreen />);

    expect(await screen.findByText(/no users yet/i)).toBeDefined();
    expect(screen.getAllByRole('button', { name: /new user/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('offers Clear filters instead of the create CTA when filters match nothing', async () => {
    stubListFetch((url) => (url.startsWith('/api/hope/admin/users?') ? listResponse([]) : undefined));
    renderWithProviders(<UsersListScreen />, { searchParams: '?search=zzz' });

    expect(await screen.findByText(/no users match/i)).toBeDefined();
    // Both the toolbar and the filtered-empty CTA expose a clear affordance.
    expect(screen.getAllByRole('button', { name: /clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the block error state and retries the request', async () => {
    const calls = stubFetch((url, init) => settingsResponse(url, init) ?? Response.json({ message: 'Service unavailable' }, { status: 503 }));
    renderWithProviders(<UsersListScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes('/admin/users?')).length).toBe(2));
  });

  it('maps search + typed filters + page onto the gateway bracket-grammar request', async () => {
    // Typed filters live in the compact `f` URL param (JSON tuples); enum columns
    // serialize to `field[equals]:v`, tokens joined by `;`.
    const f = encodeURIComponent(
      JSON.stringify([
        ['resourceStatus', 'eq', 'select', 'DISABLED'],
        ['isServiceAccount', 'eq', 'select', 'true'],
      ]),
    );
    const calls = stubListFetch();
    renderWithProviders(<UsersListScreen />, { searchParams: `?search=mia&f=${f}&page=2&limit=50` });

    await screen.findByText('mia.okafor');
    const call = listCall(calls);
    expect(call.url.split('?')[0]).toBe('/api/hope/admin/users');
    const q = queryOf(call.url);
    expect(q.get('search')).toBe('mia');
    expect(q.get('searchFields')).toBe('username,externalId');
    expect(q.get('filters')).toBe('resourceStatus[equals]:DISABLED;isServiceAccount[equals]:true');
    // URL `page=2` is the 0-based grid index (the THIRD page) → 1-based wire page 3.
    expect(q.get('page')).toBe('3');
    expect(q.get('limit')).toBe('50');
  });

  it('requests the default sort and reflects header sorting in the URL state', async () => {
    const calls = stubListFetch();
    const onUrlUpdate = vi.fn();
    renderWithProviders(<UsersListScreen />, { onUrlUpdate });

    await screen.findByText('mia.okafor');
    expect(queryOf(listCall(calls).url).get('sort')).toBe('createdAt:desc');

    // The grid sorts from the column-header menu; picking "Asc" writes `sort=` to the URL.
    fireEvent.pointerDown(screen.getByRole('button', { name: /user column options/i }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^asc$/i }));
    await waitFor(() => {
      const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
      expect(last?.searchParams.get('sort')).toBe('username:asc');
    });
  });

  // Cross-tenant admin surface: Tenant column + tenant filter.
  it('renders the Tenant column with catalog names resolved from role assignments', async () => {
    stubListFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    // u-1 has an assignment in t-1 → catalog name; u-2 has none → em dash.
    expect(await screen.findByText('Acme Hospital')).toBeDefined();
  });

  it('routes an active tenant filter through the by-tenant endpoint without a tenantId CSV token', async () => {
    const f = encodeURIComponent(
      JSON.stringify([
        ['tenantId', 'eq', 'select', 't-1'],
        ['resourceStatus', 'eq', 'select', 'ENABLED'],
      ]),
    );
    const calls = stubListFetch();
    renderWithProviders(<UsersListScreen />, { searchParams: `?f=${f}` });

    await screen.findByText('mia.okafor');
    const call = calls.find((entry) => entry.method === 'GET' && entry.url.includes('/admin/users/tenant/t-1?'));
    expect(call).toBeDefined();
    // The remaining typed filters still ride the CSV grammar — minus the tenant rule.
    expect(queryOf(call!.url).get('filters')).toBe('resourceStatus[equals]:ENABLED');
    // The cross-tenant list is paused while the tenant filter is active.
    expect(calls.some((entry) => entry.method === 'GET' && entry.url.includes('/admin/users?'))).toBe(false);
  });

  it('forwards the active tenant filter to the export as a dedicated tenantId param', async () => {
    const createObjectURL = vi.fn(() => 'blob:users');
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const f = encodeURIComponent(JSON.stringify([['tenantId', 'eq', 'select', 't-1']]));
    const calls = stubListFetch((url) => {
      if (url.includes('/admin/users/export')) {
        return new Response('username\nmia.okafor\n', {
          status: 200,
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="users.csv"' },
        });
      }
      return undefined;
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    renderWithProviders(<UsersListScreen />, { searchParams: `?f=${f}` });

    await screen.findByText('mia.okafor');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /export selected/i }));

    await waitFor(() => {
      const exportCall = calls.find((call) => call.url.includes('/admin/users/export'));
      expect(exportCall).toBeDefined();
      const q = queryOf(exportCall!.url);
      expect(q.get('tenantId')).toBe('t-1');
      // The tenant rule must NOT leak into the CSV grammar.
      expect(q.get('filters')).toBeNull();
    });
    anchorClick.mockRestore();
  });

  it('navigates to the user detail when a row is clicked', async () => {
    stubListFetch();
    renderWithProviders(<UsersListScreen />);

    fireEvent.click(await screen.findByText('jonas.weber'));
    expect(push).toHaveBeenCalledWith('/users/u-2');
  });

  it('disables a user from the row menu through its confirm dialog', async () => {
    const calls = stubListFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    openRowMenu('mia.okafor');
    fireEvent.click(await screen.findByRole('menuitem', { name: /disable/i }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^disable$/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/users/u-1/status');
      expect(patch?.body).toEqual({ resourceStatus: 'DISABLED' });
    });
  });

  it('requires typing the username to arm the row delete', async () => {
    const calls = stubListFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    openRowMenu('mia.okafor');
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /delete user/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: 'mia.okafor' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/hope/admin/users/u-1')).toBe(true));
  });

  it('runs a bulk disable over the grid-selected rows through its confirm dialog', async () => {
    const calls = stubListFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    // The grid owns selection now: its per-row checkboxes carry the generic "Select row"
    // name. Re-query before each click — selecting a row re-renders the virtualized body,
    // so a node captured earlier would be stale.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[1]);
    await screen.findByText(/2 selected/i);

    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^disable$/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/users/bulk-actions');
      expect(post?.body).toEqual({ action: 'disable', ids: ['u-1', 'u-2'] });
    });
  });

  /** Shared harness for the two export scopes: stub the blob download + URL/anchor globals. */
  function stubExportFetch() {
    const createObjectURL = vi.fn(() => 'blob:users');
    const revokeObjectURL = vi.fn();
    // happy-dom would actually navigate the anchor; intercept the download click.
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const calls = stubListFetch((url) => {
      if (url.includes('/admin/users/export')) {
        return new Response('username\nmia.okafor\n', {
          status: 200,
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="users.csv"' },
        });
      }
      return undefined;
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    return { calls, createObjectURL, revokeObjectURL, anchorClick };
  }

  // TASK-986 R6 — the export scope must follow the SELECTION, and the label
  // must say which scope is about to run (rule 11 §5: no silent scope change
  // under an unchanged label).
  it('exports ONLY the selected rows from the bulk action bar, naming them in `ids`', async () => {
    const { calls, createObjectURL, revokeObjectURL, anchorClick } = stubExportFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    // Export-selected lives in the selection action bar — reveal it by selecting a row.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /export selected \(1\)/i }));

    await waitFor(() => {
      const exportCall = calls.find((call) => call.url.includes('/admin/users/export'));
      expect(exportCall).toBeDefined();
      const q = queryOf(exportCall!.url);
      expect(q.get('format')).toBe('csv');
      expect(q.get('ids')).toBe('u-1');
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:users');
    anchorClick.mockRestore();
  });

  it('exports the whole filtered view from the header Export all — no `ids` param', async () => {
    const { calls, anchorClick } = stubExportFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    fireEvent.click(await screen.findByRole('button', { name: /export all/i }));

    await waitFor(() => {
      const exportCall = calls.find((call) => call.url.includes('/admin/users/export'));
      expect(exportCall).toBeDefined();
      const q = queryOf(exportCall!.url);
      expect(q.get('format')).toBe('csv');
      expect(q.get('ids')).toBeNull();
    });
    anchorClick.mockRestore();
  });

  it('counts every selected row in the action-bar export label', async () => {
    stubExportFetch();
    renderWithProviders(<UsersListScreen />);

    await screen.findByText('mia.okafor');
    // Re-query between clicks: selecting a row re-renders the virtual grid.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[1]);

    expect(await screen.findByRole('button', { name: /export selected \(2\)/i })).toBeDefined();
  });

  it('creates a user through the dialog and navigates to the new detail page', async () => {
    const calls = stubListFetch((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('/api/hope/admin/users?')) return listResponse([]);
      return undefined;
    });
    renderWithProviders(<UsersListScreen />);
    await screen.findByText(/no users yet/i);

    fireEvent.click(screen.getAllByRole('button', { name: /new user/i })[0]);
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText(/^username/i), { target: { value: 'anna' } });
    fireEvent.change(within(dialog).getByLabelText(/^password/i), { target: { value: 'pw-123456' } });
    // TASK-983 R6: role + department are mandatory — the gateway refuses a
    // membership-less create, so the dialog collects both before it can submit.
    await pickOption(within(dialog).getByLabelText(/^role/i), 'Clinician');
    await pickOption(within(dialog).getByLabelText(/^department/i), 'General Medicine (GEN)');
    fireEvent.click(within(dialog).getByRole('button', { name: /create user/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/users');
      expect(post?.body).toEqual({ username: 'anna', password: 'pw-123456', roleId: 'role-clinician', departmentId: 'dept-gen' });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/users/u-new'));
  });
});
