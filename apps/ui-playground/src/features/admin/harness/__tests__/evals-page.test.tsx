/**
 * TASK-330 Phase 6 (polish) — Harness evals page. Verifies the detail drawer's
 * description renders a <Skeleton> (not the literal "Loading…" string) while a
 * run loads, that a failed list query shows an inline error state (not an empty
 * state), and that an onError toast callback is wired into the eval-runs query.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  list: {} as Record<string, unknown>,
  detail: {} as Record<string, unknown>,
  listSpy: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../api/harness', () => ({
  useHarnessEvalRuns: (params: unknown, options: unknown) => {
    h.listSpy(params, options);
    return h.list;
  },
  useHarnessEvalRun: () => h.detail,
}));

vi.mock('sonner', () => ({ toast: h.toast }));

vi.mock('../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { tenantId: string; isGlobalScope: () => boolean }) => unknown) => selector({ tenantId: 't1', isGlobalScope: () => false }),
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
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    ScrollArea: Pass,
    Sheet: ({ children }: any) => <div>{children}</div>,
    SheetContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    // Mirror Radix `asChild`: render the child element directly so the Skeleton
    // (a div) is not wrapped in a <p>.
    SheetDescription: ({ children, asChild: _asChild }: any) => <div>{children}</div>,
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

const { default: HarnessEvalsPage } = await import('../evals');

const run = {
  id: 'run-1',
  tenantId: 't1',
  goldenSetId: 'gs-1',
  modelName: 'gpt',
  modelVersion: '1',
  promptTemplateId: null,
  promptVersion: null,
  judgeModel: 'judge',
  status: 'COMPLETED',
  startedAt: '2026-06-01T10:00:00.000Z',
  completedAt: '2026-06-01T11:00:00.000Z',
  aggregateScores: { overall: 0.9 },
  notes: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T11:00:00.000Z',
};

describe('HarnessEvalsPage', () => {
  beforeEach(() => {
    h.list = {};
    h.detail = { data: undefined, isLoading: false };
    h.listSpy.mockReset();
    h.toast.error.mockReset();
  });

  it('shows skeletons while the run list loads', () => {
    h.list = { data: undefined, isLoading: true, isFetching: true };
    render(<HarnessEvalsPage />);
    expect(screen.getByTestId('evals-skeleton')).toBeInTheDocument();
  });

  it('renders an empty state when there are no runs', () => {
    h.list = { data: { items: [], total: 0 }, isLoading: false, isFetching: false };
    render(<HarnessEvalsPage />);
    expect(screen.getByText('No eval runs')).toBeInTheDocument();
  });

  it('shows an inline error state (not an empty state) when the run list fails', () => {
    h.list = { data: undefined, isLoading: false, isFetching: false, isError: true, error: new Error('down') };
    render(<HarnessEvalsPage />);
    expect(screen.getByTestId('harness-error')).toBeInTheDocument();
    expect(screen.queryByText('No eval runs')).not.toBeInTheDocument();
  });

  it('renders a <Skeleton> (not a "Loading…" string) in the detail description while the run loads', () => {
    h.list = { data: { items: [run], total: 1 }, isLoading: false, isFetching: false };
    h.detail = { data: undefined, isLoading: true };
    render(<HarnessEvalsPage />);
    expect(screen.getByTestId('evals-detail-desc-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('wires an onError toast callback into the eval-runs query', () => {
    h.list = { data: { items: [], total: 0 }, isLoading: false, isFetching: false };
    render(<HarnessEvalsPage />);
    const [, options] = h.listSpy.mock.calls.at(-1) as [unknown, { onError?: unknown }];
    expect(typeof options.onError).toBe('function');
  });
});
