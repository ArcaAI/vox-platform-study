/**
 * CC-05 (TASK-336) — the DNA admin screen must expose a Generate affordance
 * wired to the (previously unreachable) admin generate endpoint.
 *
 * Selecting a tenant user reveals a "Generate" action in the Report Versions
 * column; clicking it fires the admin generate mutation for that doctor, scoped
 * to the active tenant. `MultiColumnLayout` is stubbed to render each column's
 * items (so a user can be selected) and its `headerActions` (where Generate
 * lives). Heavy/unrelated deps are stubbed, mirroring the sibling page tests.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const generateSpy = vi.fn();

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ tenantId: 'tenant-abc' }),
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/version-diff-panel', () => ({ VersionDiffPanel: () => <div /> }));
vi.mock('./dna-dashboard-summary', () => ({ DnaDashboardSummary: () => <div /> }));
vi.mock('../dna-dashboard-summary', () => ({ DnaDashboardSummary: () => <div /> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../api/dna-reports', () => ({
  useAdminGenerateDnaReport: () => ({ mutate: generateSpy, isPending: false }),
  useAdminUpdateDnaReport: () => ({ mutate: vi.fn(), isPending: false }),
  useDnaReportVersions: () => ({ data: [], isLoading: false, isFetching: false }),
  useRefreshDnaReportVersions: () => vi.fn(),
  useRefreshTenantDnaReportData: () => vi.fn(),
  useTenantDnaReportData: () => ({
    data: {
      users: [{ id: 'doc-1', username: 'drhouse', email: 'h@example.com', UserProfile: { firstName: 'Greg', lastName: 'House' } }],
      reports: [],
    },
    isLoading: false,
    isFetching: false,
  }),
}));

vi.mock('@arcaai/ui/multi-column-layout', () => ({
  MultiColumnLayout: ({ columns, columnStates }: any) => (
    <div>
      {columns.map((col: any, i: number) => {
        const st = columnStates[i] ?? {};
        return (
          <div key={col.id}>
            <div>{col.headerActions}</div>
            {typeof col.renderItem === 'function' &&
              (st.data ?? []).map((item: any) => (
                <button
                  type="button"
                  key={col.keyExtractor(item)}
                  data-testid={`item-${col.id}`}
                  onClick={() => st.onSelect?.(col.keyExtractor(item))}
                >
                  {col.keyExtractor(item)}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  ),
}));
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/form', () => ({
  Form: ({ children }: any) => <div>{children}</div>,
  FormField: () => null,
  FormItem: ({ children }: any) => <div>{children}</div>,
  FormLabel: ({ children }: any) => <label>{children}</label>,
  FormControl: ({ children }: any) => <div>{children}</div>,
  FormMessage: () => <div />,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/separator', () => ({ Separator: () => <hr /> }));
vi.mock('@arcaai/ui/scroll-area', () => ({ ScrollArea: ({ children }: any) => <div>{children}</div> }));

const { default: DnaReportsAdminPage } = await import('../index');

describe('DnaReportsAdminPage — CC-05 generate affordance', () => {
  beforeEach(() => {
    generateSpy.mockReset();
  });

  it('fires the admin generate mutation for the selected doctor, scoped to the tenant', () => {
    render(<DnaReportsAdminPage />);

    // Select the tenant user → reveals the Generate action in the versions column.
    fireEvent.click(screen.getByTestId('item-users'));

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0][0]).toMatchObject({ doctorId: 'doc-1', tenantId: 'tenant-abc' });
  });
});
