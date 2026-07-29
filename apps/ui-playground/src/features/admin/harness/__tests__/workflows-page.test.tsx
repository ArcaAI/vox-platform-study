/**
 * TASK-330 Phase 6 — Harness workflows page render/skeleton/empty + cancel flow.
 * Query hooks, toasts, the admin client, and the shared ConfirmDialog are mocked
 * so the real page wiring (confirm -> mutate -> toast) is exercised.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  state: { workflows: {} as Record<string, unknown> },
  cancelMutate: vi.fn(),
  terminateMutate: vi.fn(),
  signalMutate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../api/harness', () => ({
  useHarnessWorkflows: () => h.state.workflows,
  useCancelWorkflow: () => ({ mutate: h.cancelMutate, isPending: false }),
  useTerminateWorkflow: () => ({ mutate: h.terminateMutate, isPending: false }),
  useSignalWorkflow: () => ({ mutate: h.signalMutate, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: h.toast }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { tenantId: string; isGlobalScope: () => boolean }) => unknown) =>
    selector({ tenantId: 't1', isGlobalScope: () => false }),
}));

vi.mock('../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock('../../components', () => ({
  ConfirmDialog: ({ open, title, onConfirm }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button data-testid="confirm-ok" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

vi.mock('@arcaai/ui', () => {
  return {
    Badge: ({ children, variant: _v, ...props }: any) => <span {...props}>{children}</span>,
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Dialog: ({ open, children }: any) => (open ? <div data-testid="signal-dialog">{children}</div> : null),
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogDescription: ({ children }: any) => <div>{children}</div>,
    DialogFooter: ({ children }: any) => <div>{children}</div>,
    DialogHeader: ({ children }: any) => <div>{children}</div>,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    Select: ({ value, onValueChange, children }: any) => (
      <select aria-label="select" value={value} onChange={(e: any) => onValueChange(e.target.value)}>
        {children}
      </select>
    ),
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectValue: () => null,
    Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
    Table: ({ children }: any) => <table>{children}</table>,
    TableBody: ({ children }: any) => <tbody>{children}</tbody>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
    TableHead: ({ children }: any) => <th>{children}</th>,
    TableHeader: ({ children }: any) => <thead>{children}</thead>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
    Textarea: (props: any) => <textarea {...props} />,
  };
});

const { default: HarnessWorkflowsPage } = await import('../workflows');

const runningWf = {
  workflowId: 'wf-1',
  runId: 'run-1',
  consultationId: 'c-1',
  tenantId: 't1',
  status: 'RUNNING',
  phase: 'DRAFT',
  startedAt: '2026-06-01T10:00:00.000Z',
  closeTime: null,
  regenCount: 1,
  escalations: 0,
  slaSeconds: 120,
};

describe('HarnessWorkflowsPage', () => {
  beforeEach(() => {
    h.cancelMutate.mockReset();
    h.terminateMutate.mockReset();
    h.signalMutate.mockReset();
    h.toast.success.mockReset();
    h.toast.error.mockReset();
    h.cancelMutate.mockImplementation((_vars: unknown, opts: any) => opts?.onSuccess?.());
    h.state.workflows = { data: undefined, isLoading: true, isFetching: true, refetch: vi.fn() };
  });

  it('shows skeletons while loading', () => {
    render(<HarnessWorkflowsPage />);
    expect(screen.getByTestId('workflows-skeleton')).toBeInTheDocument();
  });

  it('renders an empty state when there are no workflows', () => {
    h.state.workflows = { data: { items: [], nextPageToken: null }, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<HarnessWorkflowsPage />);
    expect(screen.getByTestId('harness-empty')).toBeInTheDocument();
    expect(screen.getByText('No workflows')).toBeInTheDocument();
  });

  it('renders a workflow row with status', () => {
    h.state.workflows = { data: { items: [runningWf], nextPageToken: null }, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<HarnessWorkflowsPage />);
    const row = screen.getByTestId('workflows-row');
    expect(row).toBeInTheDocument();
    // The status badge lives inside the row (the Select also lists a RUNNING option).
    expect(row).toHaveTextContent('RUNNING');
  });

  it('cancel action requires confirmation then mutates and toasts success', () => {
    h.state.workflows = { data: { items: [runningWf], nextPageToken: null }, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<HarnessWorkflowsPage />);

    // No confirm dialog until the destructive action is invoked.
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflows-cancel'));
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('Cancel workflow?');

    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(h.cancelMutate).toHaveBeenCalledWith(
      { workflowId: 'wf-1', tenantId: 't1' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(h.toast.success).toHaveBeenCalledWith('Workflow cancellation requested');
  });

  it('opens the signal dialog for a running workflow', () => {
    h.state.workflows = { data: { items: [runningWf], nextPageToken: null }, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<HarnessWorkflowsPage />);
    expect(screen.queryByTestId('signal-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workflows-signal'));
    expect(screen.getByTestId('signal-dialog')).toBeInTheDocument();
  });

  it('Reset restores the status + consultation filters to their defaults', () => {
    h.state.workflows = { data: { items: [], nextPageToken: null }, isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<HarnessWorkflowsPage />);

    const consultation = screen.getByLabelText('Consultation ID') as HTMLInputElement;
    fireEvent.change(consultation, { target: { value: 'c-123' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'RUNNING' } });
    fireEvent.click(screen.getByTestId('workflows-apply'));

    fireEvent.click(screen.getByTestId('workflows-reset'));

    expect((screen.getByLabelText('Consultation ID') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('__all__');
  });
});
