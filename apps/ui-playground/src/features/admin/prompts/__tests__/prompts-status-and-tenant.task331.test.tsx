/**
 * TASK-331 doc-02 F5 + F3 — prompts page wiring.
 *
 *  - F5: choosing a status in the list filter threads `status` into the
 *    server-side query params (the client-side post-filter was removed).
 *  - F3: selecting a tenant persists via `setTenant` (not the deprecated
 *    `setTenantKey`).
 *
 * `MultiColumnLayout` is stubbed to render each column's `headerActions` and to
 * expose the column states so the tenant `onSelect` can be invoked directly.
 * `@arcaai/ui/select` is stubbed as a native `<select>` so the status filter is
 * a plain combobox.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const store = vi.hoisted(() => ({ setTenant: vi.fn(), tenantId: '', isGlobalScope: true }));
const infinite = vi.hoisted(() => ({ calls: [] as { tenantId: string; params: any }[] }));
const mcl = vi.hoisted(() => ({ columns: null as any, states: null as any }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ tenantId: store.tenantId, isGlobalScope: () => store.isGlobalScope, setTenant: store.setTenant }),
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components', () => ({ ConfirmDialog: () => null, StatusBadge: ({ status }: any) => <span>{status}</span> }));
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, onClick, disabled }: any) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}));

vi.mock('@arcaai/ui/multi-column-layout', () => ({
  MultiColumnLayout: ({ columns, columnStates }: any) => {
    mcl.columns = columns;
    mcl.states = columnStates;
    return (
      <div>
        {columns.map((c: any) => (
          <div key={c.id} data-col={c.id}>
            {c.headerActions}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('../../api/tenants', () => ({
  useTenantsInfinite: () => ({ data: undefined, hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false, isRefetching: false, refetch: vi.fn() }),
}));
vi.mock('../../api/prompts', () => ({
  usePromptTemplatesInfinite: (tenantId: string, params: any) => {
    infinite.calls.push({ tenantId, params });
    return { data: undefined, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false, isRefetching: false, refetch: vi.fn() };
  },
  usePromptVersions: () => ({ data: [], isLoading: false, isRefetching: false, refetch: vi.fn() }),
  usePromptTemplate: () => ({ data: undefined, isLoading: false }),
  usePromptUsageStats: () => ({ data: undefined, isLoading: false }),
  useCreatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useTogglePromptStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useActivatePromptVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshPromptDetails: () => vi.fn(),
}));

const { default: PromptManagementPage } = await import('../index');

describe('PromptManagementPage status + tenant wiring (TASK-331 doc-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.setTenant.mockReset();
    store.tenantId = 't-1';
    store.isGlobalScope = true;
    infinite.calls.length = 0;
  });

  // F5 — status filter is server-side.
  it('threads the selected status into the infinite-query params', () => {
    render(<PromptManagementPage />);

    // Baseline: no status param before filtering.
    const before = infinite.calls[infinite.calls.length - 1];
    expect(before.params).not.toHaveProperty('status');

    // headerActions renders [category, status] selects in DOM order.
    const combos = screen.getAllByRole('combobox');
    fireEvent.change(combos[1], { target: { value: 'PUBLISHED' } });

    const after = infinite.calls[infinite.calls.length - 1];
    expect(after.params).toMatchObject({ status: 'PUBLISHED' });
  });

  // F3 — selecting a tenant persists via setTenant.
  it('persists a tenant selection to the store via setTenant', () => {
    store.tenantId = '';
    render(<PromptManagementPage />);

    const tenantsState = mcl.states[0]; // tenants column is first for a global-scope admin
    act(() => tenantsState.onSelect('t-2'));

    expect(store.setTenant).toHaveBeenCalledWith('t-2', undefined);
  });
});
