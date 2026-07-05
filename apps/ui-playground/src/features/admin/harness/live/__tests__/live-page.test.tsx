/**
 * TASK-341 B6 — Admin Harness "Live" page.
 *
 * Verifies the page states (loading / empty / error / active), that selecting a
 * session mounts the live SOAP viewer for that consultation (reusing
 * `LiveSummaryPanel` fed by the admin SSE hook), and the engine kill-switch:
 * global-scope admins get a confirm → PATCH → toast flow; tenant admins get a
 * disabled control with a reason (the endpoint 403s for them). Query/mutation
 * hooks, the SSE hook, the panel, toasts, ConfirmDialog and `@arcaai/ui` are
 * mocked so the real page wiring drives.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sessions: {} as Record<string, unknown>,
  config: {} as Record<string, unknown>,
  updateMutate: vi.fn(),
  stream: { event: null, status: 'idle', error: null, lastUpdatedAt: null } as Record<string, unknown>,
  tenantId: 't1',
  globalScope: true,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../api/live', () => ({
  useLiveSessions: () => h.sessions,
  useLiveEngineConfig: () => h.config,
  useUpdateLiveEngineConfig: () => ({ mutate: h.updateMutate, isPending: false }),
}));

vi.mock('../use-admin-live-summary-stream', () => ({
  useAdminLiveSummaryStream: (opts: { consultationId: string | null }) => ({ ...h.stream, consultationId: opts.consultationId }),
}));

vi.mock('@/features/clinical-workspace/components/live-summary-panel', () => ({
  LiveSummaryPanel: ({ status }: { status: string }) => <div data-testid="live-summary-panel">panel:{status}</div>,
}));

vi.mock('sonner', () => ({ toast: h.toast }));

vi.mock('../../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock('../../../components', () => ({
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

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { tenantId: string; isGlobalScope: () => boolean }) => unknown) =>
    selector({ tenantId: h.tenantId, isGlobalScope: () => h.globalScope }),
}));

vi.mock('@arcaai/ui', () => {
  const Pass = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  return {
    Badge: ({ children, variant: _v, ...props }: any) => <span {...props}>{children}</span>,
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
    Switch: ({ checked, onCheckedChange, disabled, ...props }: any) => (
      <input
        type="checkbox"
        role="switch"
        checked={!!checked}
        disabled={!!disabled}
        onChange={(e: any) => onCheckedChange?.(e.target.checked)}
        {...props}
      />
    ),
    Table: ({ children }: any) => <table>{children}</table>,
    TableBody: ({ children }: any) => <tbody>{children}</tbody>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
    TableHead: ({ children }: any) => <th>{children}</th>,
    TableHeader: ({ children }: any) => <thead>{children}</thead>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
  };
});

const { default: HarnessLivePage } = await import('../index');

const session = {
  consultationId: 'c-1',
  tenantId: 't1',
  sessionId: 's-1',
  startedAt: '2026-06-08T09:00:00.000Z',
  lastUpdatedAt: '2026-06-08T10:00:00.000Z',
  flushCount: 12,
  generation: 12,
  smrLatencyMs: 350,
  nlpLatencyMs: 120,
  smrFailed: false,
  nlpFailed: false,
  staleDropCount: 0,
  entityCount: 5,
  sectionCount: 4,
  summaryChars: 800,
};

const loadedSessions = { data: { items: [session], total: 1 }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };
const enabledConfig = { data: { enabled: true, envDefault: true, source: 'env-default' }, isLoading: false, isError: false, refetch: vi.fn() };

beforeEach(() => {
  h.updateMutate.mockReset();
  h.toast.success.mockReset();
  h.toast.error.mockReset();
  h.updateMutate.mockImplementation((_vars: unknown, opts: any) => opts?.onSuccess?.());
  h.globalScope = true;
  h.stream = { event: null, status: 'idle', error: null, lastUpdatedAt: null };
  h.sessions = { data: undefined, isLoading: true, isFetching: true, isError: false, refetch: vi.fn() };
  h.config = enabledConfig;
});

describe('HarnessLivePage', () => {
  it('shows skeletons while the sessions list loads', () => {
    render(<HarnessLivePage />);
    expect(screen.getByTestId('live-sessions-skeleton')).toBeInTheDocument();
  });

  it('renders an empty state when there are no active sessions', () => {
    h.sessions = { data: { items: [], total: 0 }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() };
    render(<HarnessLivePage />);
    expect(screen.getByTestId('harness-empty')).toBeInTheDocument();
    expect(screen.getByText('No active sessions')).toBeInTheDocument();
  });

  it('renders an error state (not empty) when the sessions query fails', () => {
    h.sessions = { data: undefined, isLoading: false, isFetching: false, isError: true, error: new Error('down'), refetch: vi.fn() };
    render(<HarnessLivePage />);
    expect(screen.getByTestId('harness-error')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions')).not.toBeInTheDocument();
  });

  it('renders active session rows with live stats', () => {
    h.sessions = loadedSessions;
    render(<HarnessLivePage />);
    const row = screen.getByTestId('live-session-row');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('c-1');
    expect(row).toHaveTextContent('12');
  });

  it('selecting a session mounts the live SOAP viewer for that consultation', () => {
    h.sessions = loadedSessions;
    render(<HarnessLivePage />);
    expect(screen.queryByTestId('live-soap-viewer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('live-session-row'));

    const viewer = screen.getByTestId('live-soap-viewer');
    expect(viewer).toBeInTheDocument();
    expect(viewer).toHaveTextContent('c-1');
    expect(screen.getByTestId('live-summary-panel')).toBeInTheDocument();
  });

  it('toggling the kill-switch confirms, PATCHes, and toasts (global scope)', () => {
    h.sessions = loadedSessions;
    render(<HarnessLivePage />);

    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    const sw = screen.getByTestId('live-engine-switch') as HTMLInputElement;
    expect(sw.disabled).toBe(false);

    fireEvent.click(sw); // currently enabled → toggle to disable
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(h.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(h.toast.success).toHaveBeenCalled();
  });

  it('disables the kill-switch with a reason for tenant admins (non-global scope)', () => {
    h.globalScope = false;
    h.sessions = loadedSessions;
    render(<HarnessLivePage />);

    const sw = screen.getByTestId('live-engine-switch') as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByTestId('live-engine-controls')).toHaveTextContent(/global-admin|platform/i);

    fireEvent.click(sw);
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(h.updateMutate).not.toHaveBeenCalled();
  });
});
