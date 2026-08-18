/**
 * Frame N — Workflow Runs list screen (TASK-723, Phase C).
 *
 * fetch is stubbed at the network boundary. Assertions cover: the fill-height
 * grid renders keyset rows, the sandbox toggle round-trips `includeSandbox`
 * through the URL and the request, row click navigates to the trace route
 * keyed by `WorkflowRun.runId` (never the row `id`), the empty state, and an
 * axe scan (AC: 0 violations).
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { WorkflowRun, WorkflowRunsPage } from '../../api/types';
import { WorkflowRunsScreen } from '../workflow-runs-screen';
import { installFetchStub, sessionPayload, type RecordedCall } from './fetch-stub';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wr-1',
    tenantId: 'tnt-1',
    workflowVersionId: 'wfv-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 3,
    definitionName: 'Triage Workflow',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    status: 'COMPLETED',
    isSandbox: false,
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:01:00.000Z',
    durationMs: 60_000,
    nodeCount: 3,
    failedNodeCount: 0,
    degradedNodeCount: 0,
    firstErrorCode: null,
    createdAt: '2026-08-16T10:01:00.000Z',
    ...overrides,
  };
}

const RUNS_PAGE: WorkflowRunsPage = { data: [run()], nextCursor: null, hasMore: false, limit: 25 };
const EMPTY_PAGE: WorkflowRunsPage = { data: [], nextCursor: null, hasMore: false, limit: 25 };

function stubRoutes(overrides: { runs?: WorkflowRunsPage; workingTenantId?: string | null } = {}) {
  return installFetchStub(({ url, method }: RecordedCall) => {
    if (url === '/api/auth/session') return sessionPayload({ workingTenantId: overrides.workingTenantId });
    if (url.includes('/users/me/settings')) return method === 'GET' ? [] : { ok: true };
    if (url.startsWith('/api/hope/admin/workflow-runs?')) return overrides.runs ?? RUNS_PAGE;
    return { success: true };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

describe('WorkflowRunsScreen', () => {
  it('renders the header, grid rows and the cross-tenant cross-link', async () => {
    stubRoutes();
    renderWithProviders(<WorkflowRunsScreen />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Workflow Runs' })).toBeDefined());
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Workflow runs' })).toBeDefined());
    expect(await screen.findByText('Triage Workflow')).toBeDefined();
    expect(screen.getByRole('link', { name: /See all agentic runs/ }).getAttribute('href')).toBe('/ai-operations/runs');
  });

  it('excludes sandbox runs by default', async () => {
    const calls = stubRoutes();
    renderWithProviders(<WorkflowRunsScreen />);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Workflow runs' })).toBeDefined());
    const listCall = calls.find((call) => call.url.startsWith('/api/hope/admin/workflow-runs?'));
    expect(listCall?.url).not.toContain('includeSandbox=true');
  });

  it('the sandbox toggle round-trips into the request', async () => {
    const calls = stubRoutes();
    renderWithProviders(<WorkflowRunsScreen />);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Workflow runs' })).toBeDefined());
    screen.getByLabelText('Include sandbox runs').click();
    await waitFor(() => expect(calls.some((call) => call.url.includes('includeSandbox=true'))).toBe(true));
  });

  it('navigates to the trace route keyed by runId (never the row id) on row click', async () => {
    stubRoutes();
    renderWithProviders(<WorkflowRunsScreen />);
    const row = await screen.findByText('Triage Workflow');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/workflow-runs/run-1'));
  });

  it('shows the empty state when there are no runs', async () => {
    stubRoutes({ runs: EMPTY_PAGE });
    renderWithProviders(<WorkflowRunsScreen />);
    expect(await screen.findByText('No workflow runs yet')).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<WorkflowRunsScreen />);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Workflow runs' })).toBeDefined());
    await screen.findByText('Triage Workflow');
    expect(await axe(container)).toHaveNoViolations();
  });
});
