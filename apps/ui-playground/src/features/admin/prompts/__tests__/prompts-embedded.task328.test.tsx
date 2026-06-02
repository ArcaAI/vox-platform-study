/**
 * TASK-328 A2 — Prompt admin page composed as a tenant-scoped tab.
 *
 * The same `PromptManagementPage` is reused (not forked) inside the
 * tenant-detail "Prompts" tab via `scopedTenantId` + `embedded`. This smoke
 * test asserts the composition contract:
 *   - embedded + scopedTenantId  → the tenant-picker column is hidden and the
 *     prompt list is fetched for the scoped tenant.
 *   - non-embedded super-admin   → the tenant-picker column is shown.
 *
 * `MultiColumnLayout` is stubbed to surface each column's title; the data
 * hooks / store are stubbed so the page renders without a backend.
 */
import { render, screen } from '@testing-library/react';

const authState = vi.hoisted(() => ({ isSuperAdmin: true, tenantKey: '' }));
const promptsInfinite = vi.hoisted(() => vi.fn());

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) =>
    selector({
      tenantKey: authState.tenantKey,
      isSuperAdmin: () => authState.isSuperAdmin,
      setTenantKey: vi.fn(),
    }),
}));

vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div data-testid="main">{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The Create + Confirm dialogs are always mounted (open={false}); gate their
// bodies on `open` so we don't pull real Radix internals into this smoke test.
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('../../components', () => ({
  ConfirmDialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  StatusBadge: ({ status }: any) => <span>{status}</span>,
}));

vi.mock('@arcaai/ui/multi-column-layout', () => ({
  MultiColumnLayout: ({ columns }: any) => (
    <div data-testid="mcl">
      {columns.map((c: any) => (
        <div key={c.id} data-testid={`col-${c.id}`}>
          {c.title}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../../api/tenants', () => ({
  useTenantsInfinite: () => ({
    data: undefined,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../api/prompts', () => ({
  usePromptTemplatesInfinite: (tenantId: string, params: unknown) => {
    promptsInfinite(tenantId, params);
    return {
      data: undefined,
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
      isRefetching: false,
      refetch: vi.fn(),
    };
  },
  usePromptVersions: () => ({ data: [], isLoading: false, isRefetching: false, refetch: vi.fn() }),
  usePromptTemplate: () => ({ data: undefined, isLoading: false }),
  usePromptUsageStats: () => ({ data: undefined, isLoading: false }),
  useCreatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useTogglePromptStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshPromptDetails: () => vi.fn(),
}));

import PromptManagementPage from '../index';

describe('PromptManagementPage composition (TASK-328 A2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isSuperAdmin = true;
    authState.tenantKey = '';
  });

  it('hides the tenant picker and scopes the prompt query when embedded', () => {
    render(<PromptManagementPage scopedTenantId="t-9" embedded />);

    // No page chrome (Main) in embedded mode.
    expect(screen.queryByTestId('main')).not.toBeInTheDocument();
    // Tenant-picker column is dropped even for a super admin.
    expect(screen.queryByTestId('col-tenants')).not.toBeInTheDocument();
    // Prompt list is fetched for the scoped tenant.
    expect(promptsInfinite).toHaveBeenCalledWith('t-9', expect.anything());
  });

  it('shows the tenant picker for a non-embedded super admin', () => {
    render(<PromptManagementPage />);

    expect(screen.getByTestId('main')).toBeInTheDocument();
    expect(screen.getByTestId('col-tenants')).toBeInTheDocument();
  });
});
