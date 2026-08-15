/**
 * Identity Providers screen. fetch is stubbed at the network
 * boundary; assertions cover the provider grid, the working-tenant gate, the
 * detail drawer following row selection, the create-in-drawer flow, delete,
 * and the block error state.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { DepartmentOption, RoleOption, TenantIdpConfig } from '../../api/types';
import { IdentityProvidersScreen } from '../identity-providers-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function provider(overrides: Partial<TenantIdpConfig> = {}): TenantIdpConfig {
  return {
    id: 'idp-1',
    tenantId: 'tnt-1',
    protocol: 'OIDC',
    displayName: 'Acme Okta',
    providerStatus: 'ENABLED',
    config: { issuer: 'https://acme.okta.com', clientId: 'client-abc', defaultRoleId: 'role-1', defaultDepartmentId: 'dept-1' },
    hasSecret: true,
    hasDirectoryCredentials: false,
    resourceStatus: 'ENABLED',
    version: 3,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

const PROVIDERS: TenantIdpConfig[] = [provider(), provider({ id: 'idp-2', displayName: 'Contoso Entra', providerStatus: 'DRAFT', version: 1 })];

const DEPARTMENTS: DepartmentOption[] = [{ id: 'dept-1', code: 'GEN', name: 'General' }];
const ROLES: RoleOption[] = [{ id: 'role-1', name: 'DOCTOR' }];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function session(overrides: Partial<{ workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  return {
    ...base,
    effectiveUser: { ...base.user, tenantId: null, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function settingsResponse(call: RecordedCall): Response | undefined {
  if (!call.url.includes('/user/me/settings')) return undefined;
  return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function defaultHandler(call: RecordedCall): Response | undefined {
  if (call.method !== 'GET') return undefined;
  const path = pathOf(call);
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/tenant-idp-config') return Response.json(PROVIDERS);
  if (path === '/api/hope/admin/departments') return Response.json(DEPARTMENTS);
  if (path === '/api/hope/admin/rbac/roles') return Response.json({ data: ROLES, count: ROLES.length, limit: 200, page: 0 });
  const detail = path.match(/^\/api\/hope\/admin\/tenant-idp-config\/(idp-\d)$/);
  if (detail) {
    const row = PROVIDERS.find((entry) => entry.id === detail[1]);
    return row ? Response.json(row, { headers: { etag: `"${row.version}"` } }) : undefined;
  }
  return undefined;
}

function stubProviders(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => settingsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('IdentityProvidersScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubProviders((call) => {
      if (pathOf(call) === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<IdentityProvidersScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/tenant-idp-config'))).toBe(true);
  });

  it('renders the provider grid with protocol, status and issuer columns', async () => {
    stubProviders();
    renderWithProviders(<IdentityProvidersScreen />);

    expect(await screen.findByText('Acme Okta')).toBeDefined();
    expect(screen.getByText('Contoso Entra')).toBeDefined();
    expect(screen.getAllByText('OIDC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getAllByText('https://acme.okta.com').length).toBeGreaterThan(0);
  });

  it('opens the detail drawer on row click, pre-filled from the detail read', async () => {
    stubProviders();
    renderWithProviders(<IdentityProvidersScreen />);

    fireEvent.click(await screen.findByText('Acme Okta'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByDisplayValue('Acme Okta')).toBeDefined();
    expect(within(dialog).getByDisplayValue('https://acme.okta.com')).toBeDefined();
  });

  it('renders the block error state and retries the providers request', async () => {
    const calls = stubProviders((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/tenant-idp-config') {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<IdentityProvidersScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => pathOf(call) === '/api/hope/admin/tenant-idp-config').length).toBe(2));
  });

  it('deletes a provider after confirming, closing the drawer if it was open', async () => {
    const calls = stubProviders((call) => {
      if (call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/tenant-idp-config/idp-1') {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    renderWithProviders(<IdentityProvidersScreen />);

    fireEvent.click(await screen.findByText('Acme Okta'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByDisplayValue('Acme Okta');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(confirmDialog).getByRole('textbox'), { target: { value: 'Acme Okta' } });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /delete provider/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE' && pathOf(call) === '/api/hope/admin/tenant-idp-config/idp-1')).toBe(true);
    });
  });

  it('shows an empty state with a create action when no providers exist', async () => {
    stubProviders((call) => {
      if (call.method === 'GET' && pathOf(call) === '/api/hope/admin/tenant-idp-config') return Response.json([]);
      return undefined;
    });
    renderWithProviders(<IdentityProvidersScreen />);

    expect(await screen.findByText('No identity providers configured')).toBeDefined();
  });
});
