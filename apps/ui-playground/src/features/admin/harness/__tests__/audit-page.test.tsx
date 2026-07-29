/**
 * TASK-330 Phase 6 — Harness audit page render/skeleton/empty + chain badge.
 * The query layer (`../api/harness`) and `@arcaai/ui` are mocked so the real
 * page logic drives under jsdom.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ audit: {} as Record<string, unknown>, auditSpy: vi.fn() }));

vi.mock('../api/harness', () => ({
  useHarnessAudit: (params: unknown, options: unknown) => {
    state.auditSpy(params, options);
    return state.audit;
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { tenantId: string; isGlobalScope: () => boolean }) => unknown) =>
    selector({ tenantId: 't1', isGlobalScope: () => false }),
}));

vi.mock('@arcaai/ui', () => {
  const Pass = ({ children }: any) => <div>{children}</div>;
  return {
    Badge: ({ children, variant: _v, ...props }: any) => <span {...props}>{children}</span>,
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    ScrollArea: Pass,
    Select: ({ value, onValueChange, children }: any) => (
      <select aria-label="select" value={value} onChange={(e: any) => onValueChange(e.target.value)}>
        {children}
      </select>
    ),
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectValue: () => null,
    Sheet: ({ children }: any) => <div>{children}</div>,
    SheetContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SheetDescription: ({ children }: any) => <div>{children}</div>,
    SheetHeader: ({ children }: any) => <div>{children}</div>,
    SheetTitle: ({ children }: any) => <div>{children}</div>,
    Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
    Table: ({ children }: any) => <table>{children}</table>,
    TableBody: ({ children }: any) => <tbody>{children}</tbody>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
    TableHead: ({ children }: any) => <th>{children}</th>,
    TableHeader: ({ children }: any) => <thead>{children}</thead>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
  };
});

const { default: HarnessAuditPage } = await import('../audit');

const event = {
  id: 'e1',
  tenantId: 't1',
  consultationId: 'c1234567890',
  contextItemVersionId: null,
  action: 'GATE_DECISION',
  modelName: 'smr-v1',
  modelVersion: '1.0',
  promptTemplateId: null,
  promptVersion: null,
  sensorScores: { coverage: 0.9 },
  citations: [],
  gateDecision: 'APPROVE',
  clinicianId: 'doc-1',
  attestationHash: null,
  prevHash: '0'.repeat(64),
  hash: 'abcdef1234567890',
  createdAt: '2026-06-01T10:00:00.000Z',
  createdBy: null,
};

describe('HarnessAuditPage', () => {
  beforeEach(() => {
    state.audit = {};
    state.auditSpy.mockReset();
  });

  it('shows skeletons while loading', () => {
    state.audit = { data: undefined, isLoading: true, isFetching: true };
    render(<HarnessAuditPage />);
    expect(screen.getByTestId('audit-skeleton')).toBeInTheDocument();
  });

  it('renders an empty state when there are no events', () => {
    state.audit = { data: { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } }, isLoading: false, isFetching: false };
    render(<HarnessAuditPage />);
    expect(screen.getByTestId('harness-empty')).toBeInTheDocument();
    expect(screen.getByText('No audit events')).toBeInTheDocument();
  });

  it('shows an inline error state (not a misleading empty state) when the query fails', () => {
    state.audit = { data: undefined, isLoading: false, isFetching: false, isError: true, error: new Error('nope') };
    render(<HarnessAuditPage />);
    expect(screen.getByTestId('harness-error')).toBeInTheDocument();
    expect(screen.queryByTestId('harness-empty')).not.toBeInTheDocument();
  });

  it('wires an onError toast callback into the audit query', () => {
    state.audit = { data: { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } }, isLoading: false, isFetching: false };
    render(<HarnessAuditPage />);
    const [, options] = state.auditSpy.mock.calls.at(-1) as [unknown, { onError?: unknown }];
    expect(typeof options.onError).toBe('function');
  });

  it('commits the action + date-range filters to the server query on Apply', () => {
    state.audit = { data: { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } }, isLoading: false, isFetching: false };
    render(<HarnessAuditPage />);

    // The single mocked <select> is the action filter; the date inputs are labelled.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'GATE_DECISION' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-02-28' } });
    fireEvent.click(screen.getByTestId('audit-apply'));

    const [params] = state.auditSpy.mock.calls.at(-1) as [{ action?: string; from?: string; to?: string }, unknown];
    expect(params.action).toBe('GATE_DECISION');
    expect(params.from).toBe(new Date('2026-02-01T00:00:00.000').toISOString());
    expect(params.to).toBe(new Date('2026-02-28T23:59:59.999').toISOString());
  });

  it('clears applied filters on Reset', () => {
    state.audit = { data: { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } }, isLoading: false, isFetching: false };
    render(<HarnessAuditPage />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'GATE_DECISION' } });
    fireEvent.click(screen.getByTestId('audit-apply'));
    fireEvent.click(screen.getByTestId('audit-reset'));

    const [params] = state.auditSpy.mock.calls.at(-1) as [{ action?: string; from?: string; to?: string }, unknown];
    expect(params.action).toBeUndefined();
    expect(params.from).toBeUndefined();
    expect(params.to).toBeUndefined();
  });

  it('renders rows and a verified chain badge', () => {
    state.audit = { data: { items: [event], total: 1, verification: { valid: true, brokenAtIndex: null } }, isLoading: false, isFetching: false };
    render(<HarnessAuditPage />);
    expect(screen.getByTestId('audit-row')).toBeInTheDocument();
    expect(screen.getByTestId('audit-chain-badge')).toHaveTextContent('Chain verified');
    expect(screen.getAllByText('GATE_DECISION').length).toBeGreaterThan(0);
  });

  it('shows a broken-chain badge with the break index', () => {
    state.audit = {
      data: { items: [event], total: 1, verification: { valid: false, brokenAtIndex: 2, reason: 'hash mismatch' } },
      isLoading: false,
      isFetching: false,
    };
    render(<HarnessAuditPage />);
    expect(screen.getByTestId('audit-chain-badge')).toHaveTextContent('Chain broken at #2');
  });
});
