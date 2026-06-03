import { render, screen } from '@testing-library/react';

import { RequireAdmin, RequireGlobalScope } from '../admin-route-guard';
import { useAuthStore } from '@/store/auth-store';

// The real router context isn't available in unit tests; stub `Navigate` so we
// can assert *where* a blocked user is redirected without mounting a router.
vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

const baseUser = { id: 'u-1', email: 'test@example.com', username: 'tester', permissions: [] as string[] };

function setRoles(roles: string[]) {
  useAuthStore.getState().setCredentialsAuth('token', { ...baseUser, roles }, 'tenant-1');
}

describe('admin route guards', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.getState().logout();
  });

  describe('RequireAdmin', () => {
    // TASK-331 doc-05 F-4 — GLOBAL_ADMIN ≡ SUPER_ADMIN (product decision: "global
    // admin is super admin, with no limits in any tenant"), reversing the doc-04
    // "dead arm" pin, so it reaches every admin page like SUPER_ADMIN.
    it.each(['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'])('renders children for %s', (role) => {
      setRoles([role]);
      render(
        <RequireAdmin>
          <div data-testid="page" />
        </RequireAdmin>,
      );
      expect(screen.getByTestId('page')).toBeInTheDocument();
      expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
    });

    it('redirects a non-admin clinical role to /403', () => {
      setRoles(['DOCTOR']);
      render(
        <RequireAdmin>
          <div data-testid="page" />
        </RequireAdmin>,
      );
      expect(screen.queryByTestId('page')).not.toBeInTheDocument();
      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/403');
    });

    it('redirects when there is no authenticated user', () => {
      render(
        <RequireAdmin>
          <div data-testid="page" />
        </RequireAdmin>,
      );
      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/403');
    });
  });

  describe('RequireGlobalScope (Prisma Studio surface)', () => {
    // TASK-331 doc-05 F-4 — GLOBAL_ADMIN ≡ SUPER_ADMIN, so it now carries global
    // scope (reversing the doc-04 pin that grouped it with the bound roles).
    it.each(['SUPER_ADMIN', 'GLOBAL_ADMIN'])('renders children for the global-scope role %s', (role) => {
      setRoles([role]);
      render(
        <RequireGlobalScope>
          <div data-testid="studio" />
        </RequireGlobalScope>,
      );
      expect(screen.getByTestId('studio')).toBeInTheDocument();
    });

    it.each(['TENANT_ADMIN', 'DOCTOR'])('redirects non-global-scope role %s to /403', (role) => {
      setRoles([role]);
      render(
        <RequireGlobalScope>
          <div data-testid="studio" />
        </RequireGlobalScope>,
      );
      expect(screen.queryByTestId('studio')).not.toBeInTheDocument();
      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/403');
    });
  });
});
