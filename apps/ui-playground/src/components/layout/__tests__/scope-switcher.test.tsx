/**
 * TASK-327 T4 — ScopeSwitcher.
 *
 * D1: global scope (SUPER_ADMIN / GLOBAL_ADMIN) gets an interactive tenant
 * picker; TENANT_ADMIN gets a locked, non-interactive badge. The @arcaai/ui
 * primitives are globally stubbed, so each subpath is mocked with a
 * render-through shim; the popover/command shims render their children
 * eagerly so list items are queryable without opening.
 */
import { fireEvent, render, screen } from '@testing-library/react';

const store = vi.hoisted(() => ({
  isGlobal: true,
  tenantId: '',
  tenantName: '',
  tenantKey: '',
}));
const mockSetTenant = vi.hoisted(() => vi.fn());
const tenantsQuery = vi.hoisted(() => ({
  current: { data: { data: [] as any[], count: 0, page: 1, limit: 100 }, isLoading: false } as any,
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) =>
    selector({
      isGlobalScope: () => store.isGlobal,
      tenantId: store.tenantId,
      tenantName: store.tenantName,
      tenantKey: store.tenantKey,
      setTenant: mockSetTenant,
    }),
}));

vi.mock('@/features/admin/api/tenants', () => ({
  useAdminTenants: () => tenantsQuery.current,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@arcaai/ui/popover', () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/command', () => ({
  Command: ({ children }: any) => <div>{children}</div>,
  CommandInput: ({ placeholder }: any) => <input placeholder={placeholder} />,
  CommandList: ({ children }: any) => <div>{children}</div>,
  CommandEmpty: ({ children }: any) => <div>{children}</div>,
  CommandGroup: ({ children }: any) => <div>{children}</div>,
  CommandItem: ({ children, onSelect }: any) => (
    <div role="option" onClick={() => onSelect?.()}>
      {children}
    </div>
  ),
}));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span data-testid="badge" {...p}>{children}</span> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div data-testid="skeleton" {...p} /> }));
vi.mock('@arcaai/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
}));

import { ScopeSwitcher } from '../scope-switcher';

const tenants = [
  { id: 't-1', name: 'Acme Hospital', key: 'acme', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' },
  { id: 't-2', name: 'Beta Clinic', key: 'beta', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' },
  // TASK-335 #1 — the platform `__SYSTEM__` tenant must never be selectable as a working tenant.
  { id: 't-sys', name: 'System', key: '__SYSTEM__', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' },
];

describe('ScopeSwitcher (TASK-327 T4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.isGlobal = true;
    store.tenantId = '';
    store.tenantName = '';
    store.tenantKey = '';
    tenantsQuery.current = { data: { data: tenants, count: tenants.length, page: 1, limit: 100 }, isLoading: false };
  });

  describe('global scope', () => {
    it('renders an interactive tenant picker', () => {
      render(<ScopeSwitcher />);
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(screen.getByText('Select tenant')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search tenants...')).toBeInTheDocument();
    });

    it('calls setTenant with the chosen tenant id + name on select', () => {
      render(<ScopeSwitcher />);
      fireEvent.click(screen.getByText('Beta Clinic'));
      expect(mockSetTenant).toHaveBeenCalledWith('t-2', 'Beta Clinic');
    });

    it('shows a Skeleton while the tenant list is loading', () => {
      tenantsQuery.current = { data: undefined, isLoading: true };
      render(<ScopeSwitcher />);
      expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    });

    it('excludes the __SYSTEM__ tenant from the working-tenant list (TASK-335)', () => {
      render(<ScopeSwitcher />);
      // Customer tenants remain selectable…
      expect(screen.getByText('Acme Hospital')).toBeInTheDocument();
      expect(screen.getByText('Beta Clinic')).toBeInTheDocument();
      // …but the platform System tenant is filtered out (owns no customer data).
      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });
  });

  describe('tenant-admin (locked scope)', () => {
    beforeEach(() => {
      store.isGlobal = false;
      store.tenantId = 't-1';
      store.tenantName = 'Acme Hospital';
    });

    it('renders a locked badge and no picker', () => {
      render(<ScopeSwitcher />);
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.getByText('Acme Hospital')).toBeInTheDocument();
      expect(screen.getByText('Scoped to your tenant')).toBeInTheDocument();
    });

    it('does not call setTenant (non-interactive)', () => {
      render(<ScopeSwitcher />);
      expect(screen.queryByRole('option')).not.toBeInTheDocument();
      expect(mockSetTenant).not.toHaveBeenCalled();
    });
  });
});
