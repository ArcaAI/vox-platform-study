/**
 * Frame 12 — Tenants list screen (AdminDataGrid). fetch is stubbed at the
 * network boundary (the api layer has its own tests); assertions here are the
 * rendered list states, the request the typed filters produce (the NEW gateway
 * BRACKET grammar `field[op]:value` joined by `;`), and the wizard POST.
 *
 * The grid persists per-user layout via `GET user/me/settings`, so every render
 * fires that call too; `settingsResponse` answers it and assertions locate the
 * list request by URL rather than by call index.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Tenant } from '../../api/types';
import { TenantsListScreen } from '../tenants-list-screen';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-1',
    projectId: null,
    createdAt: '2025-03-02T10:00:00.000Z',
    updatedAt: '2025-06-28T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    version: 7,
    name: 'Sunrise Medical Group',
    key: 'tnt_9f2ka7',
    description: 'Flagship clinic network',
    plan: 'ENTERPRISE',
    tags: ['pilot'],
    ...overrides,
  };
}

const TENANTS = [tenant(), tenant({ id: 't-2', name: 'Bayview Health Network', key: 'tnt_4h8mz1', plan: 'PRO', resourceStatus: 'SUSPENDED' })];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved layout in tests. */
function settingsResponse(url: string, init?: RequestInit): Response | undefined {
  if (!url.includes('/user/me/settings')) return undefined;
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

function listResponse(rows: Tenant[]): Response {
  return Response.json({ data: rows, count: rows.length, limit: 25, page: 0 });
}

/** The gateway list request (skips the interleaved `user/me/settings` layout GET). */
function listRequest(calls: RecordedCall[]): URL {
  const call = calls.find((entry) => entry.method === 'GET' && entry.url.includes('/admin/tenants'));
  if (!call) throw new Error('no /admin/tenants GET recorded');
  return new URL(call.url, 'http://test.local');
}

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockClear();
  cleanup();
});

describe('TenantsListScreen', () => {
  it('renders tenant rows with key, plan and status from the list payload', async () => {
    stubFetch((url, init) => settingsResponse(url, init) ?? listResponse(TENANTS));
    renderWithProviders(<TenantsListScreen />);

    expect(await screen.findByText('Sunrise Medical Group')).toBeDefined();
    expect(screen.getByText('Bayview Health Network')).toBeDefined();
    expect(screen.getByText('tnt_4h8mz1')).toBeDefined();
    expect(screen.getByText('Enterprise')).toBeDefined();
    expect(screen.getByText(/2 tenants/i)).toBeDefined();
  });

  it('shows the no-tenants empty state with a create CTA when the list is empty', async () => {
    stubFetch((url, init) => settingsResponse(url, init) ?? listResponse([]));
    renderWithProviders(<TenantsListScreen />);

    expect(await screen.findByText(/no tenants yet/i)).toBeDefined();
    // Header action + empty-state CTA both offer the create entry point.
    expect(screen.getAllByRole('button', { name: /new tenant/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('offers Clear filters instead of the create CTA when filters match nothing', async () => {
    stubFetch((url, init) => settingsResponse(url, init) ?? listResponse([]));
    renderWithProviders(<TenantsListScreen />, { searchParams: '?search=zzz' });

    expect(await screen.findByText(/no tenants match/i)).toBeDefined();
    // Both the toolbar and the filtered-empty CTA expose a clear affordance.
    expect(screen.getAllByRole('button', { name: /clear filters/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the block error state and retries the request', async () => {
    const calls = stubFetch((url, init) => settingsResponse(url, init) ?? Response.json({ message: 'Service unavailable' }, { status: 503 }));
    renderWithProviders(<TenantsListScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes('/admin/tenants')).length).toBe(2));
  });

  it('maps search + typed filters + page onto the gateway bracket-grammar request', async () => {
    // Typed filters live in the compact `f` URL param (JSON tuples); enum columns
    // serialize to `field[equals]:v`, tokens joined by `;`.
    const f = encodeURIComponent(
      JSON.stringify([
        ['resourceStatus', 'eq', 'select', 'SUSPENDED'],
        ['plan', 'eq', 'select', 'PRO'],
      ]),
    );
    const calls = stubFetch((url, init) => settingsResponse(url, init) ?? listResponse(TENANTS));
    renderWithProviders(<TenantsListScreen />, { searchParams: `?search=north&f=${f}&page=1&limit=50` });

    await screen.findByText('Sunrise Medical Group');
    const requested = listRequest(calls);
    expect(requested.pathname).toBe('/api/hope/admin/tenants');
    expect(requested.searchParams.get('search')).toBe('north');
    expect(requested.searchParams.get('searchFields')).toBe('name,key');
    expect(requested.searchParams.get('filters')).toBe('resourceStatus[equals]:SUSPENDED;plan[equals]:PRO');
    // URL `page=1` is the 0-based grid index (the SECOND page); the gateway is 1-based
    // (`skip=(page-1)*limit`), so the wire page is 2. (pagination fix.)
    expect(requested.searchParams.get('page')).toBe('2');
    expect(requested.searchParams.get('limit')).toBe('50');
  });

  it('requests the default sort and reflects header sorting in the URL state', async () => {
    const calls = stubFetch((url, init) => settingsResponse(url, init) ?? listResponse(TENANTS));
    const onUrlUpdate = vi.fn();
    renderWithProviders(<TenantsListScreen />, { onUrlUpdate });

    await screen.findByText('Sunrise Medical Group');
    expect(listRequest(calls).searchParams.get('sort')).toBe('updatedAt:desc');

    // The grid sorts from the column-header menu; picking "Asc" writes `sort=` to the URL.
    fireEvent.pointerDown(screen.getByRole('button', { name: /name column options/i }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^asc$/i }));
    await waitFor(() => {
      const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
      expect(last?.searchParams.get('sort')).toBe('name:asc');
    });
  });

  it('navigates to the tenant detail when a row is clicked', async () => {
    stubFetch((url, init) => settingsResponse(url, init) ?? listResponse(TENANTS));
    renderWithProviders(<TenantsListScreen />);

    fireEvent.click(await screen.findByText('Bayview Health Network'));
    expect(push).toHaveBeenCalledWith('/tenants/t-2');
  });

  it('runs a lifecycle action from the row menu through its confirm dialog', async () => {
    const calls = stubFetch((url, init) => {
      const settings = settingsResponse(url, init);
      if (settings) return settings;
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/admin/tenants?')) return listResponse(TENANTS);
      if (init?.method === 'POST' && url === '/api/hope/admin/tenants/t-1/suspend') {
        return Response.json(tenant({ resourceStatus: 'SUSPENDED' }));
      }
      return undefined;
    });
    renderWithProviders(<TenantsListScreen />);

    const trigger = await screen.findByRole('button', { name: /open actions for sunrise medical group/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /suspend/i }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^suspend$/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/t-1/suspend')).toBe(true));
  });

  // The wizard now has a mandatory 3rd (tenant-admin) step
  // (existing user picked via the UserPicker combobox) and submits through
  // POST /admin/tenants/provision, never adminless.
  it('creates a tenant with an admin through the wizard and navigates to the new detail page', async () => {
    const calls = stubFetch((url, init) => {
      const settings = settingsResponse(url, init);
      if (settings) return settings;
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/admin/tenants?')) return listResponse([]);
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/api/hope/admin/users')) {
        return Response.json({ data: [{ id: 'user-1', username: 'admin.acme', isServiceAccount: false }], count: 1, limit: 10, page: 0 });
      }
      if (init?.method === 'POST' && url === '/api/hope/admin/tenants/provision') {
        return Response.json({ tenant: tenant({ id: 't-new', name: 'Acme Health', key: 'acme' }), adminUserId: 'user-1', tenantKey: 'acme' });
      }
      return undefined;
    });
    renderWithProviders(<TenantsListScreen />);
    await screen.findByText(/no tenants yet/i);

    fireEvent.click(screen.getAllByRole('button', { name: /new tenant/i })[0]);
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Acme Health' } });
    fireEvent.change(within(dialog).getByLabelText(/^key/i), { target: { value: 'acme' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));

    // Step 2 (plan, defaults to STARTER) -> step 3 (tenant admin, defaults to
    // "existing user", picked via the UserPicker — its popover portals to body).
    fireEvent.click(within(dialog).getByRole('button', { name: /next/i }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: /user/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search users by username/i), { target: { value: 'admin.acme' } });
    fireEvent.click(await screen.findByText('admin.acme'));
    fireEvent.click(within(dialog).getByRole('button', { name: /create tenant/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url === '/api/hope/admin/tenants/provision');
      expect(post?.body).toEqual({ tenantName: 'Acme Health', tenantKey: 'acme', plan: 'STARTER', admin: { mode: 'existing', userId: 'user-1' } });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tenants/t-new'));
  });
});
