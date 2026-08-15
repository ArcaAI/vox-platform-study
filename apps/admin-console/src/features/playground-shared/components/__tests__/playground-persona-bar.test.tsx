/**
 * Content-level persona bar. Supersedes PlaygroundTopBar chrome:
 * the persona/impersonation control now renders as ordinary
 * scrolling content inside the console shell, self-fetching the session
 * instead of receiving it as a server-passed prop.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PlaygroundPersonaBar } from '../playground-persona-bar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubSessionFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/session')) {
        const body = {
          user: { id: 'admin-1', username: 'alice-admin', email: 'alice@hope.test', roles: ['SUPER_ADMIN'], tenantId: null },
          isElevated: true,
          workingTenantId: null,
          workingTenantName: null,
          impersonatingUserId: null,
          impersonatingUsername: null,
          effectiveUser: {
            id: 'admin-1',
            username: 'alice-admin',
            email: 'alice@hope.test',
            roles: ['SUPER_ADMIN'],
            tenantId: null,
            departmentId: null,
          },
          effectiveIsElevated: true,
          effectiveTenantId: null,
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('PlaygroundPersonaBar', () => {
  it('shows a skeleton before the session loads', () => {
    stubSessionFetch();
    const { container } = renderWithProviders(<PlaygroundPersonaBar />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('renders PersonaControl once the session resolves', async () => {
    stubSessionFetch();
    renderWithProviders(<PlaygroundPersonaBar />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /acting as yourself/i })).toBeDefined();
    });
    expect(screen.getByText(/under alice-admin/i)).toBeDefined();
  });
});
