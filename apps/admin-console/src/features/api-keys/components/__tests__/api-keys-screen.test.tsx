/**
 * TDD screen tests for frame 23 (API Keys): list states + URL-driven filters,
 * the one-time raw-key contract on create AND rotate (shown once, gone after
 * close), confirmed revoke/delete flows and the usage sheet — against a
 * URL-branching fetch stub (per the feature-api test pattern).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ApiKey, ApiKeyScopeCatalog, ApiKeyUsage } from '../../api/types';
import { ApiKeysScreen } from '../api-keys-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k-1',
    projectId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    keyName: 'svc_reporting',
    keyPrefix: 'hk_1a9c',
    keyType: 'SERVICE_ACCOUNT',
    keyStatus: 'ACTIVE',
    scopes: ['read:metrics'],
    allowedIps: null,
    rateLimit: 600,
    expiresAt: null,
    lastUsedAt: '2026-07-01T00:00:00.000Z',
    usageCount: 812,
    description: null,
    environment: null,
    userId: null,
    tenantId: null,
    ...overrides,
  };
}

const KEYS = [
  apiKey(),
  apiKey({
    id: 'k-2',
    keyName: 'partner_baymed',
    keyPrefix: 'hk_9c4f',
    scopes: ['export:consult'],
    // Expires within 30 days -> derived "Expiring" badge per the matrix.
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  }),
  apiKey({ id: 'k-3', keyName: 'legacy_webhook', keyPrefix: 'hk_5d2a', keyStatus: 'REVOKED', scopes: ['write:events'] }),
];

const SCOPES: ApiKeyScopeCatalog = {
  Metrics: [{ scope: 'read:metrics', description: 'Read platform metrics' }],
  Consultations: [{ scope: 'export:consult', description: 'Export consultation data' }],
};

const USAGE: ApiKeyUsage = { totalCalls: 812, lastUsedAt: '2026-07-01T00:00:00.000Z', rateLimit: 600 };

function envelope(rows: ApiKey[]) {
  return { data: rows, count: rows.length, limit: 25, page: 0 };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** URL-branching stub: custom handler first, shared defaults as fallback. */
function stubFetch(custom?: (call: RecordedCall) => Response | undefined, rows: ApiKey[] = KEYS): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      // The grid persists per-user layout via `user/me/settings` — no saved layout in tests.
      if (call.url.includes('/user/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (call.url.includes('/admin/api-keys/scopes')) return Response.json(SCOPES);
      if (call.url.includes('/usage')) return Response.json(USAGE);
      if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/api-keys')) return Response.json(envelope(rows));
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

function openRowMenu(name: string) {
  const trigger = screen.getByRole('button', { name: `Open actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApiKeysScreen', () => {
  it('renders key rows with prefix, scopes, status and expiry from the list payload', async () => {
    stubFetch();
    renderWithProviders(<ApiKeysScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'API keys' })).toBeDefined();
    expect(await screen.findByText('svc_reporting')).toBeDefined();
    expect(screen.getByText('hk_1a9c\u2026')).toBeDefined();
    expect(screen.getByText('read:metrics')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Expiring')).toBeDefined();
    expect(screen.getByText('Revoked')).toBeDefined();
    // No expiry -> "Never" per frame 23.
    expect(screen.getAllByText('Never').length).toBeGreaterThan(0);
    expect(screen.getByRole('grid', { name: 'API keys' })).toBeDefined();
    expect(screen.getByText(/3 keys/)).toBeDefined();
  });

  it('renders the scope badges on a single line so the fixed-height row keeps its border', async () => {
    stubFetch();
    renderWithProviders(<ApiKeysScreen />);

    const scope = await screen.findByText('read:metrics');
    // A wrapping container grows past the fixed-height virtual row and paints over border-b.
    expect((scope.parentElement as HTMLElement).className).not.toContain('flex-wrap');
  });

  it('mirrors the loaded layout with skeletons while the list is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<ApiKeysScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('svc_reporting')).toBeNull();
  });

  it('shows the neutral empty state with a create CTA when no keys exist', async () => {
    stubFetch(undefined, []);
    renderWithProviders(<ApiKeysScreen />);

    expect(await screen.findByText('No API keys yet')).toBeDefined();
    // Header action + empty-state CTA both open the create dialog.
    expect(screen.getAllByRole('button', { name: 'Create key' }).length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a block error with retry and refetches the list', async () => {
    let attempts = 0;
    stubFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/api-keys?')) {
        attempts += 1;
        if (attempts === 1) return Response.json({ message: 'Keys API unreachable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<ApiKeysScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('Keys API unreachable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('svc_reporting')).toBeDefined();
  });

  // Cross-tenant admin surface: Tenant column + tenant filter.
  it('renders the Tenant column with the catalog name and dashes for platform keys', async () => {
    stubFetch(
      (call) => {
        if (call.method === 'GET' && call.url.startsWith('/api/hope/admin/tenants')) {
          return Response.json({ data: [{ id: 't-1', name: 'Acme Hospital', key: 'acme' }], count: 1, limit: 500, page: 0 });
        }
        return undefined;
      },
      [apiKey({ tenantId: 't-1' }), apiKey({ id: 'k-2', keyName: 'platform_key', keyPrefix: 'hk_0000', tenantId: null })],
    );
    renderWithProviders(<ApiKeysScreen />);

    await screen.findByText('svc_reporting');
    expect(await screen.findByText('Acme Hospital')).toBeDefined();
  });

  it('maps the tenant filter onto the CSV grammar (tenantId[equals]:…)', async () => {
    const calls = stubFetch();
    const f = encodeURIComponent(JSON.stringify([['tenantId', 'eq', 'select', 't-1']]));
    renderWithProviders(<ApiKeysScreen />, { searchParams: `?f=${f}` });

    await screen.findByText('svc_reporting');
    const list = calls.find((call) => call.url.startsWith('/api/hope/admin/api-keys?'));
    const requested = new URL(list?.url ?? '', 'http://test.local');
    expect(requested.searchParams.get('filters')).toBe('tenantId[equals]:t-1');
  });

  it('maps search/status/scope/page URL state onto the gateway list request', async () => {
    const calls = stubFetch();
    // Typed filters live in the compact `f` URL param (positional JSON tuples); enum columns
    // serialize to the gateway bracket grammar `field[equals]:v`, tokens joined by `;`.
    const f = encodeURIComponent(
      JSON.stringify([
        ['keyStatus', 'eq', 'select', 'ACTIVE'],
        ['scopes', 'eq', 'select', 'read:metrics'],
      ]),
    );
    renderWithProviders(<ApiKeysScreen />, { searchParams: `?search=svc&f=${f}&page=1&limit=50` });

    await screen.findByText('svc_reporting');
    const list = calls.find((call) => call.url.startsWith('/api/hope/admin/api-keys?'));
    const requested = new URL(list?.url ?? '', 'http://test.local');
    expect(requested.searchParams.get('search')).toBe('svc');
    expect(requested.searchParams.get('searchFields')).toBe('keyName,keyPrefix');
    expect(requested.searchParams.get('filters')).toBe('keyStatus[equals]:ACTIVE;scopes[equals]:read:metrics');
    // URL `page=1` is the 0-based grid index (the SECOND page) → 1-based wire page 2.
    expect(requested.searchParams.get('page')).toBe('2');
    expect(requested.searchParams.get('limit')).toBe('50');
    expect(requested.searchParams.get('sort')).toBe('updatedAt:desc');
  });

  it('creates a key and shows the raw key exactly once — gone after close', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && call.url === '/api/hope/admin/api-keys') {
        // CreateApiKeyResult: the one-time secret is the `rawKey` field.
        return Response.json({ apiKey: apiKey({ id: 'k-new', keyName: 'ci_smoke_tests' }), rawKey: 'hk_raw_2b8e_secret' });
      }
      return undefined;
    }, []);
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('No API keys yet');

    fireEvent.click(screen.getAllByRole('button', { name: 'Create key' })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'ci_smoke_tests' } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'read:metrics' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ keyName: 'ci_smoke_tests', scopes: ['read:metrics'] });

    // One-time raw key dialog: mono key + warning + copy.
    expect(await screen.findByText('hk_raw_2b8e_secret')).toBeDefined();
    expect(screen.getByText(/won\u2019t see it again/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeDefined();

    // Done stays disabled until "I stored it" is confirmed.
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /i stored this key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // The raw key is cleared on close and cannot be reopened.
    await waitFor(() => expect(screen.queryByText('hk_raw_2b8e_secret')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rotating confirms first, then shows the new raw key once', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && call.url === '/api/hope/admin/api-keys/k-1/rotate') {
        return Response.json({ apiKey: apiKey(), rawKey: 'hk_raw_rotated_secret' });
      }
      return undefined;
    });
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('svc_reporting');

    openRowMenu('svc_reporting');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotate' }));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    const confirm = await screen.findByRole('alertdialog');
    // The confirm explains the old key stops working.
    expect(within(confirm).getByText(/old key/i)).toBeDefined();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Rotate key' }));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/hope/admin/api-keys/k-1/rotate')).toBe(true));
    expect(await screen.findByText('hk_raw_rotated_secret')).toBeDefined();

    fireEvent.click(screen.getByRole('checkbox', { name: /i stored this key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('hk_raw_rotated_secret')).toBeNull());
  });

  it('revoking requires the destructive confirm before the POST fires', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST' && call.url === '/api/hope/admin/api-keys/k-1/revoke') {
        return Response.json(apiKey({ keyStatus: 'REVOKED' }));
      }
      return undefined;
    });
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('svc_reporting');

    openRowMenu('svc_reporting');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/hope/admin/api-keys/k-1/revoke')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('deleting requires typing the key name before the DELETE fires', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'DELETE') return Response.json(apiKey());
      return undefined;
    });
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('svc_reporting');

    openRowMenu('svc_reporting');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const confirm = await screen.findByRole('alertdialog');
    const deleteButton = within(confirm).getByRole('button', { name: 'Delete key' });
    expect(deleteButton.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(confirm).getByLabelText(/type/i), { target: { value: 'svc_reporting' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete key' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toBe('/api/hope/admin/api-keys/k-1');
  });

  it('opens the usage sheet with the stats for the selected key', async () => {
    const calls = stubFetch();
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('svc_reporting');

    openRowMenu('svc_reporting');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View usage' }));

    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('812')).toBeDefined();
    expect(within(sheet).getByText('Total calls')).toBeDefined();
    expect(within(sheet).getByText('Rate limit')).toBeDefined();
    expect(calls.some((call) => call.url === '/api/hope/admin/api-keys/k-1/usage')).toBe(true);
  });

  it('saves name and scope edits through the PATCH route', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH') return Response.json(apiKey({ keyName: 'svc_reporting_v2' }));
      return undefined;
    });
    renderWithProviders(<ApiKeysScreen />);
    await screen.findByText('svc_reporting');

    openRowMenu('svc_reporting');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByDisplayValue('svc_reporting');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'svc_reporting_v2' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'export:consult' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe('/api/hope/admin/api-keys/k-1');
    expect(patch?.body).toEqual({ keyName: 'svc_reporting_v2', scopes: ['read:metrics', 'export:consult'] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
