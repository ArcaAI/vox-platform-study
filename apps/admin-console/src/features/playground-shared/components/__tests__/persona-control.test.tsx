/**
 * Playground persona (impersonation) control. Covers the render states (self /
 * acting-as / no-admin-role degrade), that a TENANT_ADMIN gets the picker too
 * (D-25 — own-tenant impersonation via the legacy gateway route), the
 * "under {admin}" line always showing, and the impersonate/revoke flows (BFF
 * POST + query invalidation + router.refresh). fetch is stubbed at the network
 * boundary.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeSession } from '@/shared/auth/hooks';
import { renderWithProviders } from '@/test/render';
import { PersonaControl } from '../persona-control';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

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
  body?: unknown;
}

function stubFetch(options: { impersonateStatus?: number; reasonRequired?: boolean } = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.includes('/api/hope/admin/users')) {
        const body = { data: [{ id: 'doc-9', username: 'dr-smith', email: 'smith@hope.test' }], count: 1, limit: 8, page: 1 };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/hope/admin/settings/action-confirmations/effective')) {
        const items = options.reasonRequired ? [{ actionId: 'impersonation.start', kind: 'reason', mode: 'required', locked: false }] : [];
        return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/auth/impersonate' && options.impersonateStatus && options.impersonateStatus >= 400) {
        return new Response(JSON.stringify({ message: 'A reason is required for this action.' }), { status: options.impersonateStatus, headers: { 'content-type': 'application/json' } });
      }
      // /api/auth/impersonate and /api/auth/revoke-impersonation
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

/**
 * `impersonation.start` (owner, 2026-10-11): no reason by default — the pick impersonates at once and
 * the gateway records "Impersonation"; only when the platform admin REQUIRES a reason does the pick
 * open the shared confirm dialog first.
 */
async function confirmWithReason(reason: string) {
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: /act as/i }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: reason } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
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

  it('D-25: tenant admin (not elevated) still gets the picker — own-tenant impersonation via the legacy gateway route', () => {
    stubFetch();
    renderWithProviders(
      <PersonaControl
        session={session({
          isElevated: false,
          user: { id: 't-1', username: 'ted-tenant', email: 't@hope.test', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /acting as yourself/i })).toBeDefined();
    expect(screen.queryByText(/requires super admin/i)).toBeNull();
    expect(screen.getByText(/under ted-tenant/i)).toBeDefined();
  });

  it('neither elevated nor tenant admin: no picker, degrade reason shown, under-admin still shown', () => {
    stubFetch();
    renderWithProviders(
      <PersonaControl
        session={session({
          isElevated: false,
          user: { id: 'd-1', username: 'dana-doctor', email: 'd@hope.test', roles: ['DOCTOR'], tenantId: 'tenant-1' },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /acting as/i })).toBeNull();
    expect(screen.getByText(/acting as yourself/i)).toBeDefined();
    expect(screen.getByText(/requires an admin role/i)).toBeDefined();
    expect(screen.getByText(/under dana-doctor/i)).toBeDefined();
  });

  it('D-25: a tenant admin can select a user to act as (same flow as an elevated caller)', async () => {
    const calls = stubFetch();
    renderWithProviders(
      <PersonaControl
        session={session({
          isElevated: false,
          user: { id: 't-1', username: 'ted-tenant', email: 't@hope.test', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    const option = await screen.findByText('dr-smith');
    fireEvent.click(option);
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/auth/impersonate' && c.method === 'POST');
      expect(post?.body).toEqual({ userId: 'doc-9' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('impersonate flow: no reason by default — the pick POSTs at once, without a dialog', async () => {
    const calls = stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    fireEvent.click(await screen.findByText('dr-smith'));
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/auth/impersonate' && c.method === 'POST');
      expect(post?.body).toEqual({ userId: 'doc-9' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('impersonate flow: when the platform requires a reason, the pick asks for one and POSTs it', async () => {
    const calls = stubFetch({ reasonRequired: true });
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    const option = await screen.findByText('dr-smith');
    fireEvent.click(option);
    expect(calls.some((c) => c.url === '/api/auth/impersonate')).toBe(false);
    await confirmWithReason(' testing the scribe as this clinician ');
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/auth/impersonate' && c.method === 'POST');
      expect(post?.body).toEqual({ userId: 'doc-9', reason: 'testing the scribe as this clinician' });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  /**
   * TASK-973 RC-1 — `searchFields` used to be `'username,email'`, but `email`
   * is not a column on `User` (it lives on the related `UserProfile` model),
   * so `formatFindAllProps`'s per-field `contains` would throw at runtime
   * the moment a caller typed a query. Verifies the gateway request now
   * names only real scalar String columns on `User`.
   */
  it('RC-1: searches only real User columns (username, externalId) — never the relational email field', async () => {
    const calls = stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    await screen.findByText('dr-smith');

    fireEvent.change(screen.getByPlaceholderText(/search users to act as/i), { target: { value: 'smith' } });
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/api/hope/admin/users') && c.url.includes('search=smith'));
      expect(call).toBeDefined();
    });
    const searchCall = calls.find((c) => c.url.includes('/api/hope/admin/users') && c.url.includes('search=smith'))!;
    expect(searchCall.url).toContain('searchFields=username%2CexternalId');
    expect(searchCall.url).not.toContain('email');
  });

  /**
   * TASK-973 fix contract §3.7 — free-text search hitting the server debounces
   * at the house value (300ms, `departments-screen.tsx`) rather than firing a
   * request per keystroke.
   */
  it('debounces the server-hitting search at 300ms', async () => {
    const calls = stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    await screen.findByText('dr-smith');
    calls.length = 0;

    const input = screen.getByPlaceholderText(/search users to act as/i);
    fireEvent.change(input, { target: { value: 's' } });
    fireEvent.change(input, { target: { value: 'sm' } });
    fireEvent.change(input, { target: { value: 'smi' } });

    // Well under the 300ms debounce — no request fired yet from the typing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.filter((c) => c.url.includes('/api/hope/admin/users')).length).toBe(0);

    await waitFor(
      () => {
        expect(calls.some((c) => c.url.includes('/api/hope/admin/users') && c.url.includes('search=smi'))).toBe(true);
      },
      { timeout: 1000 },
    );
    // Only the final value was ever requested — no per-keystroke fan-out.
    expect(calls.filter((c) => c.url.includes('/api/hope/admin/users')).length).toBe(1);
  });

  it('a refused impersonation is shown as an error, not swallowed', async () => {
    stubFetch({ impersonateStatus: 400, reasonRequired: true });
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    fireEvent.click(await screen.findByText('dr-smith'));
    await confirmWithReason('testing the scribe');
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('A reason is required for this action.'));
    expect(refresh).not.toHaveBeenCalled();
    // The dialog stays open with the reason, so the admin can correct and retry.
    expect((within(screen.getByRole('alertdialog')).getByRole('textbox') as HTMLTextAreaElement).value).toBe('testing the scribe');
  });

  it('BUG-022: while impersonating, "Stop acting" is visible next to the trigger without opening the picker', () => {
    stubFetch();
    renderWithProviders(<PersonaControl session={session({ impersonatingUserId: 'doc-9', impersonatingUsername: 'dr-smith' })} />);
    expect(screen.getByRole('button', { name: /stop acting/i })).toBeDefined();
    expect(screen.queryByPlaceholderText(/search users to act as/i)).toBeNull();
  });

  it('BUG-022: no "Stop acting" when acting as yourself', () => {
    stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    expect(screen.queryByRole('button', { name: /stop acting/i })).toBeNull();
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

  describe(' accessibility — 0 axe violations', () => {
    it('tenant admin, picker open with results', async () => {
      stubFetch();
      const { container } = renderWithProviders(
        <PersonaControl
          session={session({
            isElevated: false,
            user: { id: 't-1', username: 'ted-tenant', email: 't@hope.test', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' },
          })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
      await screen.findByText('dr-smith');
      expect(await axe(container)).toHaveNoViolations();
    });

    it('no-admin-role degrade state', async () => {
      stubFetch();
      const { container } = renderWithProviders(
        <PersonaControl
          session={session({
            isElevated: false,
            user: { id: 'd-1', username: 'dana-doctor', email: 'd@hope.test', roles: ['DOCTOR'], tenantId: 'tenant-1' },
          })}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

/**
 * BUG-023 — the picker asked for 8 users and nothing more, so a tenant with more than 8 users
 * looked as if the rest did not exist. D1: a "Showing N of M" line and a Load more item that
 * appends the next page; D2: a visible scrollbar on this picker's list only.
 */
describe('PersonaControl — paging (BUG-023)', () => {
  const TOTAL = 12;
  const users = Array.from({ length: TOTAL }, (_, i) => ({ id: `u-${i}`, username: `user-${String(i).padStart(2, '0')}` }));

  function stubPagedFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        urls.push(url);
        const params = new URL(url, 'http://test.local').searchParams;
        // The real repository's offset rule: skip = max(0, (page - 1) * limit) — so 0 and 1 overlap.
        const page = Number(params.get('page') ?? 0);
        const limit = Number(params.get('limit') ?? 10);
        const skip = Math.max(0, (page - 1) * limit);
        const body = { data: users.slice(skip, skip + limit), count: TOTAL, limit, page };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    return urls;
  }

  it('shows how many users of the total are listed and loads the next page on demand', async () => {
    const urls = stubPagedFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));

    await screen.findByText('user-07');
    expect(screen.queryByText('user-08')).toBeNull();
    expect(screen.getByText(/showing 8 of 12/i)).toBeDefined();
    const first = urls.find((u) => u.includes('/api/hope/admin/users'))!;
    expect(first).toContain('page=1');
    expect(first).toContain('limit=8');

    fireEvent.click(screen.getByText(/load more/i));
    await screen.findByText('user-11');
    expect(urls.some((u) => u.includes('/api/hope/admin/users') && u.includes('page=2'))).toBe(true);
    const listed = screen.getAllByText(/^user-\d\d$/).map((node) => node.textContent);
    expect(listed).toHaveLength(TOTAL);
    expect(new Set(listed).size).toBe(TOTAL);
    expect(screen.queryByText(/load more/i)).toBeNull();
  });

  it('shows no count line or Load more when every user already fits', async () => {
    stubFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    await screen.findByText('dr-smith');
    expect(screen.queryByText(/showing \d+ of \d+/i)).toBeNull();
    expect(screen.queryByText(/load more/i)).toBeNull();
  });

  it('keeps the list scrollbar visible on this picker (not the shared CommandList)', async () => {
    stubPagedFetch();
    renderWithProviders(<PersonaControl session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /acting as yourself/i }));
    await screen.findByText('user-00');
    const list = document.querySelector('[data-slot="command-list"]');
    expect(list?.className).toContain('[&::-webkit-scrollbar]:w-2');
  });
});
