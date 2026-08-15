/**
 * Playground persona (impersonation) control. Covers the three
 * render states (self / acting-as / tenant-admin degrade), the "under {admin}"
 * line always showing, and the impersonate/revoke flows (BFF POST + query
 * invalidation + router.refresh). fetch is stubbed at the network boundary.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeSession } from '@/shared/auth/hooks';
import { renderWithProviders } from '@/test/render';
import { PersonaControl } from '../persona-control';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function session(overrides: Partial<SafeSession> = {}): SafeSession {
  return {
    user: { id: 'admin-1', username: 'alice-admin', email: 'alice@hope.test', roles: ['SUPER_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: null,
    workingTenantName: null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'admin-1', username: 'alice-admin', email: 'alice@hope.test', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: null,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/hope/admin/users')) {
        const body = { data: [{ id: 'doc-9', username: 'dr-smith', email: 'smith@hope.test' }], count: 1, limit: 8, page: 1 };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // /api/auth/impersonate and /api/auth/revoke-impersonation
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

describe('PersonaControl', () => {
  it('elevated + not impersonating: acting as yourself, under the admin', () => {
    stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    expect(screen.getByRole('button', { name: /acting as yourself/i })).toBeDefined();
    expect(screen.getByText(/under alice-admin/i)).toBeDefined();
  });

  it('impersonating: shows the target and the acting admin', () => {
    stubFetch();
    renderWithProviders(<PersonaControl session={session({ impersonatingUserId: 'doc-9', impersonatingUsername: 'dr-smith' })} />);
    expect(screen.getByRole('button', { name: /acting as .*dr-smith/i })).toBeDefined();
    expect(screen.getByText(/under alice-admin/i)).toBeDefined();
  });

  it('tenant admin (not elevated): no picker, degrade reason shown, under-admin still shown', () => {
    stubFetch();
    renderWithProviders(
      <PersonaControl
        session={session({
          isElevated: false,
          user: { id: 't-1', username: 'ted-tenant', email: 't@hope.test', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /acting as/i })).toBeNull();
    expect(screen.getByText(/acting as yourself/i)).toBeDefined();
    expect(screen.getByText(/requires global admin/i)).toBeDefined();
    expect(screen.getByText(/under ted-tenant/i)).toBeDefined();
  });

  it('impersonate flow: selecting a user POSTs to the BFF and refreshes', async () => {
    const calls = stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    const option = await screen.findByText('dr-smith');
    fireEvent.click(option);
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/auth/impersonate' && c.method === 'POST')).toBe(true);
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('revoke flow: "Stop acting" POSTs revoke and refreshes', async () => {
    const calls = stubFetch();
    renderWithProviders(<PersonaControl session={session({ impersonatingUserId: 'doc-9', impersonatingUsername: 'dr-smith' })} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as .*dr-smith/i }));
    const stop = await screen.findByRole('button', { name: /stop acting/i });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/auth/revoke-impersonation' && c.method === 'POST')).toBe(true);
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
