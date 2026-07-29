/**
 * Audit Log page smoke tests (TASK-328 A8)
 *
 * Verifies the vox-powered explorer:
 * - fetches via `useAuditLog().list` with the filter params on mount + Apply
 * - shows the responsible-user column
 * - opens the detail drawer (calls `getById`) with the pretty-printed payload
 * - the Export-CSV button triggers `exportCsv`
 * - empty state renders when there are no rows
 *
 * `@arcaai/vox` and `@arcaai/ui` are stubbed by the playground vitest config,
 * so we provide explicit test doubles.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const list = vi.fn().mockResolvedValue([]);
const getById = vi.fn();
const exportCsv = vi.fn().mockResolvedValue('id,createdAt\n');
const useAuditLogMock = vi.fn();

vi.mock('@arcaai/vox', () => ({
  useAuditLog: () => useAuditLogMock(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('lucide-react', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Download: (props: any) => <span data-testid="icon-download" {...props} />,
}));

vi.mock('@/components/layout/main', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Main: ({ children }: any) => <div data-testid="main">{children}</div>,
}));

// TASK-331 doc-03 F6 — the Tenant column is gated on global scope and resolves
// tenant ids → names via `useAdminTenants`. Both are stubbed so the page can be
// rendered without a zustand store or a React-Query provider.
const authState = vi.hoisted(() => ({ isGlobalScope: true }));
vi.mock('@/store/auth-store', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useAuthStore: (selector: any) =>
    selector({
      isGlobalScope: () => authState.isGlobalScope,
      tenantId: '',
      tenantName: '',
      setTenant: vi.fn(),
    }),
}));

const tenantsQuery = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  current: { data: { data: [{ id: 't-1', name: 'Acme Health', key: 'acme' }], count: 1 } } as any,
}));
vi.mock('../../api/tenants', () => ({
  useAdminTenants: () => tenantsQuery.current,
}));

vi.mock('@arcaai/ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Pass =
    (tag: string) =>
    ({ children, ...rest }: any) => {
      // Drop non-DOM props that would warn when spread onto a host element.
      const { variant, size, onValueChange, ...domProps } = rest;
      void variant;
      void size;
      void onValueChange;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <div {...domProps}>{children}</div>;
    };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Button: ({ children, onClick, disabled, ...rest }: any) => {
      const { variant, size, ...domProps } = rest;
      void variant;
      void size;
      return (
        <button onClick={onClick} disabled={disabled} {...domProps}>
          {children}
        </button>
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Input: ({ onChange, onKeyDown, value, id, type, placeholder, ...rest }: any) => {
      const { variant, size, ...domProps } = rest;
      void variant;
      void size;
      return <input id={id} type={type} value={value} placeholder={placeholder} onChange={onChange} onKeyDown={onKeyDown} {...domProps} />;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Label: ({ children, htmlFor }: any) => <label htmlFor={htmlFor}>{children}</label>,
    Badge: Pass('span'),
    Skeleton: Pass('div'),
    ScrollArea: Pass('div'),
    // Radix-style Select stub: expose a native <select> wired to onValueChange.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Select: ({ children, value, onValueChange }: any) => (
      <select data-testid="select" value={value} onChange={(e) => onValueChange?.(e.target.value)}>
        {children}
      </select>
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectTrigger: ({ children }: any) => <>{children}</>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectValue: ({ placeholder }: any) => <>{placeholder}</>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectContent: ({ children }: any) => <>{children}</>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
    SheetContent: Pass('div'),
    SheetHeader: Pass('div'),
    SheetTitle: Pass('div'),
    SheetDescription: Pass('div'),
    Table: Pass('div'),
    TableHeader: Pass('div'),
    TableBody: Pass('div'),
    TableRow: ({ children, onClick, ...rest }: any) => {
      const { variant, size, ...domProps } = rest;
      void variant;
      void size;
      return (
        <div role="row" onClick={onClick} {...domProps}>
          {children}
        </div>
      );
    },
    TableHead: Pass('div'),
    TableCell: Pass('div'),
  };
});

import AuditLogManagementPage from '../index';

const baseEntry = {
  id: 'audit-1',
  tenantId: 't-1',
  action: 'CREATE',
  resourceType: 'User',
  resourceId: 'res-1',
  responsibleIp: '10.0.0.1',
  responsibleUserId: 'u1',
  responsibleUser: { id: 'u1', displayName: 'Alice Nguyen', email: 'alice@example.com' },
  data: { name: 'Test' },
  createdAt: '2026-02-01T10:00:00.000Z',
};

function mockHook(overrides: Record<string, unknown> = {}) {
  useAuditLogMock.mockReturnValue({
    entries: [baseEntry],
    isLoading: false,
    error: null,
    list,
    getById,
    exportCsv,
    ...overrides,
  });
}

describe('AuditLogManagementPage (TASK-328 A8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
    exportCsv.mockResolvedValue('id,createdAt\n');
    getById.mockResolvedValue(baseEntry);
    authState.isGlobalScope = true;
  });

  it('calls list with default pagination params on mount', async () => {
    mockHook();
    render(<AuditLogManagementPage />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('pushes the date-range filter to the hook when Apply is clicked', async () => {
    mockHook();
    const { container } = render(<AuditLogManagementPage />);

    const fromInput = container.querySelector('#audit-from') as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByTestId('apply-filters'));

    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-01-01T00:00:00.000Z', page: 1 })));
  });

  it('renders the responsible-user column label', async () => {
    mockHook();
    render(<AuditLogManagementPage />);
    expect(await screen.findByTestId('audit-responsible-user')).toHaveTextContent('Alice Nguyen');
  });

  it('opens the detail drawer and shows the pretty-printed payload on row click', async () => {
    getById.mockResolvedValue({ ...baseEntry, data: { name: 'Test', nested: { ok: true } } });
    mockHook();
    render(<AuditLogManagementPage />);

    fireEvent.click(screen.getByTestId('audit-row'));

    expect(getById).toHaveBeenCalledWith('audit-1');
    const payload = await screen.findByTestId('audit-detail-data');
    await waitFor(() => expect(payload.textContent).toContain('"nested"'));
  });

  it('renders the Export CSV button and triggers exportCsv', async () => {
    mockHook();
    render(<AuditLogManagementPage />);

    const button = screen.getByTestId('export-csv');
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => expect(exportCsv).toHaveBeenCalledTimes(1));
    expect(exportCsv).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('shows an empty state when there are no rows', () => {
    mockHook({ entries: [] });
    render(<AuditLogManagementPage />);
    expect(screen.getByTestId('audit-empty')).toBeInTheDocument();
  });

  // F5 — before/after diff in the detail drawer ----------------------------
  describe('before/after payload (TASK-331 doc-03 F5)', () => {
    it('renders Before and After blocks when previousData is present', async () => {
      getById.mockResolvedValue({
        ...baseEntry,
        action: 'UPDATE',
        previousData: { status: 'active' },
        data: { status: 'inactive' },
      });
      mockHook();
      render(<AuditLogManagementPage />);

      fireEvent.click(screen.getByTestId('audit-row'));

      const before = await screen.findByTestId('audit-detail-previous');
      const after = await screen.findByTestId('audit-detail-data');
      expect(before.textContent).toContain('"active"');
      expect(after.textContent).toContain('"inactive"');
      expect(screen.getByText('Before')).toBeInTheDocument();
      expect(screen.getByText('After')).toBeInTheDocument();
    });

    it('omits the Before block for entries without previousData (CREATE/LOGIN)', async () => {
      getById.mockResolvedValue({ ...baseEntry, action: 'CREATE', previousData: null, data: { name: 'x' } });
      mockHook();
      render(<AuditLogManagementPage />);

      fireEvent.click(screen.getByTestId('audit-row'));

      await screen.findByTestId('audit-detail-data');
      expect(screen.queryByTestId('audit-detail-previous')).toBeNull();
      expect(screen.queryByText('Before')).toBeNull();
    });
  });

  // F6 — tenant column (global scope only) ---------------------------------
  describe('tenant column (TASK-331 doc-03 F6)', () => {
    it('renders the resolved tenant NAME for global-scope admins', async () => {
      authState.isGlobalScope = true;
      mockHook();
      render(<AuditLogManagementPage />);

      expect(screen.getByTestId('audit-tenant-head')).toBeInTheDocument();
      expect(await screen.findByTestId('audit-tenant')).toHaveTextContent('Acme Health');
    });

    it('is absent for tenant-scoped admins', () => {
      authState.isGlobalScope = false;
      mockHook();
      render(<AuditLogManagementPage />);

      expect(screen.queryByTestId('audit-tenant-head')).toBeNull();
      expect(screen.queryByTestId('audit-tenant')).toBeNull();
    });

    it('falls back to a truncated id (never the raw UUID) when the tenant name is unknown', async () => {
      authState.isGlobalScope = true;
      const unknownId = 'ffffffff-aaaa-bbbb-cccc-1234567890ab';
      mockHook({ entries: [{ ...baseEntry, id: 'audit-2', tenantId: unknownId }] });
      render(<AuditLogManagementPage />);

      const cell = await screen.findByTestId('audit-tenant');
      expect(cell.textContent).not.toBe(unknownId);
      expect(cell.textContent).toContain('ffffffff');
    });
  });

  // F9 — skeleton loaders (no "Loading…" text) -----------------------------
  it('shows a skeleton (not "Loading…") in the drawer while the detail loads (TASK-331 doc-03 F9)', async () => {
    let resolveDetail!: (value: unknown) => void;
    getById.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    mockHook();
    render(<AuditLogManagementPage />);

    fireEvent.click(screen.getByTestId('audit-row'));

    expect(await screen.findByTestId('audit-detail-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();

    await act(async () => {
      resolveDetail(baseEntry);
    });
  });

  // F11 — real pagination count --------------------------------------------
  describe('pagination count (TASK-331 doc-03 F11)', () => {
    it('surfaces the real total and keeps Next enabled when more pages remain', () => {
      // One row on screen, but the server reports 60 total → Next must stay enabled
      // (the old `entries.length < PAGE_SIZE` heuristic would have disabled it).
      mockHook({ count: 60, entries: [baseEntry] });
      render(<AuditLogManagementPage />);

      expect(screen.getByTestId('audit-pagination-info')).toHaveTextContent('60');
      expect(screen.getByText('Next')).not.toBeDisabled();
    });

    it('disables Next on the final page using the real count', () => {
      mockHook({ count: 25, entries: [baseEntry] });
      render(<AuditLogManagementPage />);

      expect(screen.getByText('Next')).toBeDisabled();
    });
  });
});
