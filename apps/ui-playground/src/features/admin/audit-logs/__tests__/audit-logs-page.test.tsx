/**
 * OB-08 (TASK-336) — the audit page must build its request params from the
 * COMMITTED filter only. Previously the `params` memo read the live *draft*
 * filter state, so a draft edit that hadn't been applied would silently leak
 * into the next pagination (Next/Previous) request.
 *
 * The SDK `useAuditLog` hook is stubbed to capture every `list(params)` call;
 * `@arcaai/ui` is stubbed with lightweight stand-ins so we can drive the real
 * page logic in jsdom.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const vox = vi.hoisted(() => {
  const listCalls: Array<Record<string, unknown>> = [];
  return {
    listCalls,
    list: (params: Record<string, unknown>) => {
      listCalls.push(params);
      return Promise.resolve();
    },
    getById: () => Promise.resolve({}),
    exportCsv: () => Promise.resolve(''),
  };
});

vi.mock('@/store/auth-store', () => ({
  // Non-global scope keeps the Tenant column off (no tenant-list fetch needed).
  useAuthStore: (selector: any) => selector({ isGlobalScope: () => false }),
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../api/tenants', () => ({ useAdminTenants: () => ({ data: undefined }) }));

vi.mock('@arcaai/vox', () => ({
  useAuditLog: () => ({
    entries: [],
    // A non-zero count keeps the "Next" button enabled so we can paginate.
    count: 100,
    isLoading: false,
    error: null,
    list: vox.list,
    getById: vox.getById,
    exportCsv: vox.exportCsv,
  }),
}));

vi.mock('@arcaai/ui', () => {
  const Pass = ({ children }: any) => <div>{children}</div>;
  return {
    Badge: ({ children }: any) => <span>{children}</span>,
    Button: ({ children, onClick, disabled }: any) => (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    Input: (props: any) => <input {...props} />,
    Label: ({ children }: any) => <label>{children}</label>,
    ScrollArea: Pass,
    Select: ({ value, onValueChange, children }: any) => (
      <select aria-label="filter" value={value} onChange={(e) => onValueChange(e.target.value)}>
        {children}
      </select>
    ),
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children }: any) => <>{children}</>,
    SelectValue: () => null,
    Sheet: ({ children }: any) => <div>{children}</div>,
    SheetContent: ({ children }: any) => <div>{children}</div>,
    SheetDescription: ({ children }: any) => <div>{children}</div>,
    SheetHeader: ({ children }: any) => <div>{children}</div>,
    SheetTitle: ({ children }: any) => <div>{children}</div>,
    Skeleton: () => <div />,
    Table: ({ children }: any) => <table>{children}</table>,
    TableBody: ({ children }: any) => <tbody>{children}</tbody>,
    TableCell: ({ children }: any) => <td>{children}</td>,
    TableHead: ({ children }: any) => <th>{children}</th>,
    TableHeader: ({ children }: any) => <thead>{children}</thead>,
    TableRow: ({ children }: any) => <tr>{children}</tr>,
  };
});

const { default: AuditLogManagementPage } = await import('../index');

const lastCall = () => vox.listCalls[vox.listCalls.length - 1];

describe('AuditLogManagementPage — committed filters (OB-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vox.listCalls.length = 0;
  });

  it('fetches page 1 with no filters on mount', () => {
    render(<AuditLogManagementPage />);
    expect(lastCall()).toMatchObject({ page: 1 });
    expect(lastCall().userId).toBeUndefined();
  });

  it('does NOT leak an un-applied draft filter into a pagination request', () => {
    render(<AuditLogManagementPage />);

    // Edit a DRAFT filter but never click Apply.
    fireEvent.change(screen.getByPlaceholderText('responsible user id'), { target: { value: 'draft-user' } });

    // Paginate — this must use the committed (empty) filter, not the draft.
    fireEvent.click(screen.getByText('Next'));

    expect(lastCall()).toMatchObject({ page: 2 });
    expect(lastCall().userId).toBeUndefined();
  });

  it('uses the filter only after it is committed via Apply', () => {
    render(<AuditLogManagementPage />);

    fireEvent.change(screen.getByPlaceholderText('responsible user id'), { target: { value: 'committed-user' } });
    fireEvent.click(screen.getByText('Apply'));

    expect(lastCall()).toMatchObject({ page: 1, userId: 'committed-user' });

    // A subsequent pagination keeps the committed filter and only advances page.
    fireEvent.click(screen.getByText('Next'));
    expect(lastCall()).toMatchObject({ page: 2, userId: 'committed-user' });
  });
});
