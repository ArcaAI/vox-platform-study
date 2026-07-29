/**
 * TASK-330 Phase 6 (polish) — Harness overview page. Verifies the manual
 * Refresh button refetches every panel, and that a failed query surfaces an
 * inline error state (never a misleading empty state). The query hooks,
 * toasts, and `@arcaai/ui` are mocked so the real page logic drives.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  gate: {} as Record<string, unknown>,
  audit: {} as Record<string, unknown>,
  evals: {} as Record<string, unknown>,
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../api/harness', () => ({
  useHarnessGateQueue: () => h.gate,
  useHarnessAudit: () => h.audit,
  useHarnessEvalRuns: () => h.evals,
}));

vi.mock('sonner', () => ({ toast: h.toast }));

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
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
    Table: ({ children }: any) => <table>{children}</table>,
    TableBody: ({ children }: any) => <tbody>{children}</tbody>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
    TableHead: ({ children }: any) => <th>{children}</th>,
    TableHeader: ({ children }: any) => <thead>{children}</thead>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
  };
});

const { default: HarnessOverviewPage } = await import('../overview');

const baseGate = {
  data: { items: [], total: 0, slaBreachedCount: 0, escalatedCount: 0, gateSlaSeconds: 3600, gateEscalationSeconds: 7200, policySource: 'tenant' },
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
};
const baseAudit = {
  data: { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } },
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
};
const baseEvals = { data: { items: [], total: 0 }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };

describe('HarnessOverviewPage', () => {
  beforeEach(() => {
    h.gate = baseGate;
    h.audit = baseAudit;
    h.evals = baseEvals;
    h.toast.error.mockReset();
  });

  it('refetches all three panels when Refresh is clicked', () => {
    const gateRefetch = vi.fn();
    const auditRefetch = vi.fn();
    const evalsRefetch = vi.fn();
    h.gate = { ...baseGate, refetch: gateRefetch };
    h.audit = { ...baseAudit, refetch: auditRefetch };
    h.evals = { ...baseEvals, refetch: evalsRefetch };

    render(<HarnessOverviewPage />);
    fireEvent.click(screen.getByTestId('overview-refresh'));

    expect(gateRefetch).toHaveBeenCalled();
    expect(auditRefetch).toHaveBeenCalled();
    expect(evalsRefetch).toHaveBeenCalled();
  });

  it('renders empty states (not errors) when every query succeeds with no data', () => {
    render(<HarnessOverviewPage />);
    expect(screen.getByText('Queue is clear')).toBeInTheDocument();
    expect(screen.getByText('No audit events')).toBeInTheDocument();
    expect(screen.queryByTestId('harness-error')).not.toBeInTheDocument();
  });

  it('shows an error state for the gate queue (and KPI cards) instead of "Queue is clear" when it fails', () => {
    h.gate = { ...baseGate, data: undefined, isError: true, error: new Error('down') };
    render(<HarnessOverviewPage />);

    expect(screen.queryByText('Queue is clear')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('harness-error').length).toBeGreaterThan(0);
    // The three gate-backed KPI cards show the inline failure indicator.
    expect(screen.getAllByTestId('stat-error').length).toBe(3);
  });

  it('shows an error state for recent audit activity instead of "No audit events" when it fails', () => {
    h.audit = { ...baseAudit, data: undefined, isError: true, error: new Error('down') };
    render(<HarnessOverviewPage />);

    expect(screen.queryByText('No audit events')).not.toBeInTheDocument();
    expect(screen.getByTestId('harness-error')).toBeInTheDocument();
  });
});
