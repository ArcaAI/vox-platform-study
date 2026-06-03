/**
 * TASK-327 T6 — impersonation tenant-gate.
 *
 * A global-scope operator (SUPER_ADMIN / GLOBAL_ADMIN) with no tenant
 * selected must NOT be able to impersonate: the button is disabled with a
 * tooltip that points at the real control — the header tenant switcher
 * (TASK-331 doc-06 F5; the on-page tenant card was removed). Once a tenant is
 * selected (or for a tenant-locked TENANT_ADMIN) the gate is lifted.
 *
 * `@arcaai/vox` and `@arcaai/ui/*` are globally stubbed, so each is mocked
 * here with render-through shims (the tooltip shim renders its content
 * eagerly so the reason is queryable).
 */
import { fireEvent, render, screen } from '@testing-library/react';

const scope = vi.hoisted(() => ({ roles: ['SUPER_ADMIN'] as string[], isGlobal: true, tenantId: '' }));
const sdk = vi.hoisted(() => ({ impersonate: vi.fn(), endImpersonation: vi.fn() }));

vi.mock('@/store/auth-store', () => {
  const buildState = () => ({
    user: { roles: scope.roles },
    isImpersonating: false,
    impersonatedUser: null,
    tenantId: scope.tenantId,
    isGlobalScope: () => scope.isGlobal,
    startImpersonation: vi.fn(),
    endImpersonation: vi.fn(),
  });
  const useAuthStore: any = (selector?: any) => (selector ? selector(buildState()) : buildState());
  useAuthStore.getState = () => buildState();
  return { useAuthStore };
});

const mockUser = { id: 'u1', username: 'alice', email: 'alice@example.com', resourceStatus: 'ENABLED', roles: ['DOCTOR'] };

vi.mock('@arcaai/vox', () => ({
  useUsers: () => ({
    isLoading: false,
    listPaginated: vi.fn().mockResolvedValue({ data: [mockUser], total: 1 }),
    search: vi.fn().mockResolvedValue([]),
  }),
  useAuth: () => ({ isImpersonating: false, impersonatedUser: null, impersonate: sdk.impersonate, endImpersonation: sdk.endImpersonation }),
  useStoreApi: () => ({ getState: () => ({ configManager: null }) }),
  PAGE_SIZE_OPTIONS: [10, 25, 50],
  DEFAULT_PAGE_SIZE: 10,
}));

vi.mock('@/features/admin/api/admin-client', () => ({ adminClient: { get: vi.fn() } }));
vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (p: any) => <input {...p} /> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@arcaai/ui/table', () => ({
  TableHeader: ({ children, ...p }: any) => <thead {...p}>{children}</thead>,
  TableBody: ({ children, ...p }: any) => <tbody {...p}>{children}</tbody>,
  TableRow: ({ children, ...p }: any) => <tr {...p}>{children}</tr>,
  TableHead: ({ children, ...p }: any) => <th {...p}>{children}</th>,
  TableCell: ({ children, ...p }: any) => <td {...p}>{children}</td>,
}));
vi.mock('@arcaai/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <>{children}</>,
}));

import { UserList } from '../user-list';

function startButton() {
  return screen.getByRole('button', { name: /Start Impersonation/i });
}

describe('UserList impersonation tenant-gate (TASK-327 T6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope.roles = ['SUPER_ADMIN'];
    scope.isGlobal = true;
    scope.tenantId = '';
  });

  it('global scope + no tenant → impersonate is disabled with a header-switcher reason tooltip', () => {
    render(<UserList />);
    expect(startButton()).toBeDisabled();
    // F5 — the reason points at the header tenant switcher, not a removed on-page card.
    expect(screen.getByText('Choose a tenant in the header switcher to start impersonation')).toBeInTheDocument();
    // …and no longer uses the misleading "select a tenant" phrasing.
    expect(screen.queryByText(/select a tenant/i)).not.toBeInTheDocument();
  });

  it('global scope + a selected tenant → gate lifted and impersonate enabled once a user is picked', async () => {
    scope.tenantId = 'tenant-1';
    render(<UserList />);

    expect(screen.queryByText('Choose a tenant in the header switcher to start impersonation')).not.toBeInTheDocument();
    // No user selected yet → still disabled (pre-existing rule), but not by the tenant gate.
    expect(startButton()).toBeDisabled();

    fireEvent.click(await screen.findByTestId('user-row-alice'));
    expect(startButton()).not.toBeDisabled();
  });

  it('TENANT_ADMIN (locked tenant) is never blocked by the gate', async () => {
    scope.roles = ['TENANT_ADMIN'];
    scope.isGlobal = false;
    scope.tenantId = '';
    render(<UserList />);

    expect(screen.queryByText('Choose a tenant in the header switcher to start impersonation')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('user-row-alice'));
    expect(startButton()).not.toBeDisabled();
  });
});
