import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TenantAllowedOrigin } from '../../api/types';
import { AllowedOriginsScreen } from '../allowed-origins-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const TENANT_ADMIN_SESSION = {
  ...SESSION,
  user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  effectiveIsElevated: false,
};

const ORIGINS: TenantAllowedOrigin[] = [
  {
    id: 'origin-1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    isPlatform: true,
    origin: 'https://app.example.org',
    label: 'Production app',
    description: 'Primary browser application',
    resourceStatus: 'ENABLED',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
  },
  {
    id: 'origin-2',
    tenantId: 'tenant-2',
    isPlatform: false,
    origin: 'https://staging.example.org',
    label: 'Staging app',
    resourceStatus: 'DISABLED',
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    version: 2,
  },
];

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchStub(
  session: typeof SESSION,
  handler: (url: string, method: string) => Response | Promise<Response>,
  // FR-4 posture — defaults to "on" so every test that isn't specifically
  // exercising the banner doesn't need to know this endpoint exists.
  posture: { enforcementEnabled: boolean } = { enforcementEnabled: true },
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).split('?')[0];
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url === '/api/auth/session') return Response.json(session);
      if (url.includes('/user/me/settings')) return method === 'GET' ? Response.json([]) : Response.json({ success: true });
      if (url === '/api/hope/admin/allowed-origins/posture') return Response.json(posture);
      return handler(url, method);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AllowedOriginsScreen', () => {
  it('renders both origins in the table for an elevated session', async () => {
    installFetchStub(SESSION, (url) => {
      if (url === '/api/hope/admin/allowed-origins') return Response.json(ORIGINS);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);

    expect(await screen.findByRole('grid', { name: 'Allowed origins' })).toBeDefined();
    expect(await screen.findByText('https://app.example.org')).toBeDefined();
    expect(screen.getByText('https://staging.example.org')).toBeDefined();
    // Quiet "on" confirmation — enforcement defaults to on in this stub.
    expect(await screen.findByText(/origin enforcement is on/i)).toBeDefined();
  });

  // TASK-641 FR-1/FR-5: the screen moved from the (global) tier to the
  // (tenant) tier, so a TENANT_ADMIN session now reaches it for their own
  // tenant's rows — this inverts the previous "gates non-elevated sessions"
  // assertion.
  it('renders the allow-list grid for a tenant-admin session', async () => {
    installFetchStub(TENANT_ADMIN_SESSION, (url) => {
      if (url === '/api/hope/admin/allowed-origins') return Response.json(ORIGINS);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);

    expect(await screen.findByRole('grid', { name: 'Allowed origins' })).toBeDefined();
    expect(await screen.findByText('https://app.example.org')).toBeDefined();
    expect(screen.queryByText('Global admins only')).toBeNull();
  });

  it('asks an elevated session without a working tenant to select one without fetching the allow-list', async () => {
    const session = { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null };
    const calls = installFetchStub(session, () => {
      throw new Error('allowed-origins must not be fetched without a working tenant');
    });
    renderWithProviders(<AllowedOriginsScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/api/hope/admin/allowed-origins'))).toBe(true);
    expect(screen.queryByRole('grid', { name: 'Allowed origins' })).toBeNull();
  });

  it('shows a prominent warning when origin enforcement is off, platform-wide (FR-4)', async () => {
    installFetchStub(
      SESSION,
      (url) => {
        if (url === '/api/hope/admin/allowed-origins') return Response.json(ORIGINS);
        throw new Error(`Unhandled fetch: ${url}`);
      },
      { enforcementEnabled: false },
    );
    renderWithProviders(<AllowedOriginsScreen />);

    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText(/origin enforcement is off/i)).toBeDefined();
    expect(within(banner).getByText(/no effect/i)).toBeDefined();
    expect(screen.queryByText(/origin enforcement is on/i)).toBeNull();
  });

  it('drops the stale CORS_ALLOWED_ORIGINS fallback copy from the empty state (B-5)', async () => {
    installFetchStub(SESSION, (url, method) => {
      if (url === '/api/hope/admin/allowed-origins' && method === 'GET') return Response.json([]);
      throw new Error(`Unhandled fetch: ${url} ${method}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);

    expect(await screen.findByText('No origins registered')).toBeDefined();
    expect(screen.queryByText(/CORS_ALLOWED_ORIGINS/)).toBeNull();
    expect(screen.getByText(/no fallback allow-list/i)).toBeDefined();
  });

  it('registers an origin with the expected POST payload', async () => {
    const calls = installFetchStub(SESSION, (url, method) => {
      if (url === '/api/hope/admin/allowed-origins' && method === 'GET') return Response.json([]);
      if (url === '/api/hope/admin/allowed-origins' && method === 'POST') return Response.json(ORIGINS[0], { status: 201 });
      throw new Error(`Unhandled fetch: ${url} ${method}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);
    await screen.findByText('No origins registered');

    fireEvent.click(screen.getAllByRole('button', { name: /register origin/i })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^origin/i), { target: { value: 'https://new.example.org' } });
    fireEvent.change(within(dialog).getByLabelText(/^label/i), { target: { value: 'New app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /register origin/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/hope/admin/allowed-origins');
    expect(post?.body).toEqual({ origin: 'https://new.example.org', label: 'New app' });
  });

  it('deletes an origin without sending an If-Match header', async () => {
    const calls = installFetchStub(SESSION, (url, method) => {
      if (url === '/api/hope/admin/allowed-origins' && method === 'GET') return Response.json([ORIGINS[0]]);
      if (url === `/api/hope/admin/allowed-origins/${ORIGINS[0].id}` && method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unhandled fetch: ${url} ${method}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);
    await screen.findByText(ORIGINS[0].origin);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${ORIGINS[0].label}` }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /remove origin/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    const deletion = calls.find((call) => call.method === 'DELETE');
    expect(deletion?.url).toBe(`/api/hope/admin/allowed-origins/${ORIGINS[0].id}`);
    expect(deletion?.headers.get('if-match')).toBeNull();
  });

  // FR-2: a non-elevated caller gets a guaranteed 403 from the server on a
  // wildcard/pattern origin — the form suppresses the attempt instead of
  // letting it round-trip to a failure.
  it('suppresses wildcard entry for a non-elevated (tenant-admin) session', async () => {
    const calls = installFetchStub(TENANT_ADMIN_SESSION, (url, method) => {
      if (url === '/api/hope/admin/allowed-origins' && method === 'GET') return Response.json([]);
      throw new Error(`Unhandled fetch: ${url} ${method}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);
    await screen.findByText('No origins registered');

    fireEvent.click(screen.getAllByRole('button', { name: /register origin/i })[0]);
    const dialog = await screen.findByRole('dialog');

    // Elevated-only wildcard hint is gone; the reason is stated instead.
    expect(within(dialog).queryByText(/subdomains at any depth/i)).toBeNull();
    expect(within(dialog).getByText(/wildcard patterns are managed by platform administrators/i)).toBeDefined();

    const originField = within(dialog).getByLabelText(/^origin/i);
    fireEvent.change(originField, { target: { value: 'https://*.example.org:*' } });
    fireEvent.change(within(dialog).getByLabelText(/^label/i), { target: { value: 'New app' } });

    const submit = within(dialog).getByRole('button', { name: /register origin/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);

    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps the full wildcard hint and an enabled submit for an elevated session', async () => {
    installFetchStub(SESSION, (url, method) => {
      if (url === '/api/hope/admin/allowed-origins' && method === 'GET') return Response.json([]);
      throw new Error(`Unhandled fetch: ${url} ${method}`);
    });
    renderWithProviders(<AllowedOriginsScreen />);
    await screen.findByText('No origins registered');

    fireEvent.click(screen.getAllByRole('button', { name: /register origin/i })[0]);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/subdomains at any depth/i)).toBeDefined();

    fireEvent.change(within(dialog).getByLabelText(/^origin/i), { target: { value: 'https://*.example.org:*' } });
    fireEvent.change(within(dialog).getByLabelText(/^label/i), { target: { value: 'New app' } });
    const submit = within(dialog).getByRole('button', { name: /register origin/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });
});
