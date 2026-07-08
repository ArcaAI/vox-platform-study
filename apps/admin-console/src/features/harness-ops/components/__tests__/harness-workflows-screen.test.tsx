import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { isNonTerminal, workflowRefetchInterval, workflowsRefetchInterval } from '../../api/polling';
import type { HarnessWorkflowDetail, HarnessWorkflowList, HarnessWorkflowSummary, LiveSessionsList } from '../../api/types';
import { HarnessWorkflowsScreen } from '../harness-workflows-screen';
import { installFetchStub, sessionPayload, type RecordedCall } from './fetch-stub';

const WORKFLOWS: HarnessWorkflowList = {
    items: [
        {
            workflowId: 'harness-doc-c1',
            runId: 'run-abc',
            consultationId: 'cons-1',
            tenantId: 'tnt-1',
            status: 'RUNNING',
            phase: 'GATE',
            startedAt: '2026-07-04T16:00:00.000Z',
            closeTime: null,
            regenCount: 0,
            escalations: 0,
            slaSeconds: 86_400,
        },
        {
            workflowId: 'harness-eval-77',
            runId: 'run-def',
            consultationId: null,
            tenantId: 'tnt-1',
            status: 'FAILED',
            phase: null,
            startedAt: '2026-07-03T10:00:00.000Z',
            closeTime: '2026-07-03T10:05:00.000Z',
            regenCount: null,
            escalations: null,
            slaSeconds: null,
        },
    ],
    nextPageToken: null,
};

const DETAIL: HarnessWorkflowDetail = {
    ...WORKFLOWS.items[0],
    historyLength: 42,
    pendingActivities: [{ activityType: { name: 'run_sensors' }, state: 'PENDING_ACTIVITY_STATE_STARTED', attempt: 2 }],
    memo: null,
    searchAttributes: null,
    result: null,
};

const LIVE_SESSIONS: LiveSessionsList = {
    items: [
        {
            consultationId: 'cons-9',
            tenantId: 'tnt-1',
            startedAt: '2026-07-05T06:00:00.000Z',
            lastUpdatedAt: '2026-07-05T06:59:00.000Z',
            flushCount: 12,
            generation: 12,
            smrLatencyMs: 850,
            nlpLatencyMs: 120,
            smrFailed: false,
            nlpFailed: false,
            staleDropCount: 0,
            entityCount: 34,
            sectionCount: 6,
            summaryChars: 2_400,
        },
    ],
    total: 1,
};

const ACTION_ACK = { workflowId: 'harness-doc-c1', runId: 'run-abc', status: 'RUNNING', requested: true };

function stubRoutes(overrides: { workflows?: Response | HarnessWorkflowList; workingTenantId?: string | null } = {}) {
    return installFetchStub(({ url, method }: RecordedCall) => {
        if (url === '/api/auth/session') return sessionPayload({ workingTenantId: overrides.workingTenantId });
        // Best-effort per-user grid-layout persistence (TASK-423): no saved layout in tests.
        if (url.includes('/user/me/settings')) return method === 'GET' ? [] : { ok: true };
        if (url.startsWith('/api/hope/admin/harness/workflows?')) return overrides.workflows ?? WORKFLOWS;
        if (method === 'POST' && url.endsWith('/signal')) return { ...ACTION_ACK, action: 'signal' };
        if (method === 'POST' && url.endsWith('/cancel')) return { ...ACTION_ACK, action: 'cancel' };
        if (method === 'POST' && url.endsWith('/terminate')) return { ...ACTION_ACK, action: 'terminate' };
        if (url.startsWith('/api/hope/admin/harness/workflows/')) return DETAIL;
        if (url === '/api/hope/admin/harness/live/sessions') return LIVE_SESSIONS;
        return undefined;
    });
}

async function selectFirstWorkflow() {
    fireEvent.click(await screen.findByText('harness-doc-c1'));
    // The detail lives in the console-wide slide-over (a Sheet -> role dialog).
    await screen.findByRole('dialog');
    expect(await screen.findByText(/42 history events recorded/)).toBeDefined();
}

const summary = (overrides: Partial<HarnessWorkflowSummary> = {}): HarnessWorkflowSummary => ({ ...WORKFLOWS.items[0], ...overrides });

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('HarnessWorkflowsScreen', () => {
    it('renders the workflow grid, state badges and the live sessions card', async () => {
        stubRoutes();
        renderWithProviders(<HarnessWorkflowsScreen />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Harness Workflows' })).toBeDefined();
        expect(await screen.findByText('harness-doc-c1')).toBeDefined();
        expect(screen.getByText('harness-eval-77')).toBeDefined();
        expect(screen.getByText('Running')).toBeDefined();
        expect(screen.getByText('Failed')).toBeDefined();
        expect(screen.getByRole('grid', { name: 'Harness workflows' })).toBeDefined();
        expect(await screen.findByText(/1 active/)).toBeDefined();
        expect(screen.getByText('cons-9')).toBeDefined();
    });

    it('opens the detail panel on row click and posts the signal with a parsed JSON payload', async () => {
        const calls = stubRoutes();
        renderWithProviders(<HarnessWorkflowsScreen />);
        await selectFirstWorkflow();
        expect(screen.getByText('run_sensors')).toBeDefined();
        expect(calls.some((call) => call.url === '/api/hope/admin/harness/workflows/harness-doc-c1?phase=true')).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Signal' }));
        fireEvent.change(await screen.findByLabelText(/signal name/i), { target: { value: 'approve' } });
        fireEvent.change(screen.getByLabelText(/json payload/i), { target: { value: '{"approved": true}' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send signal' }));

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/signal'));
            expect(post?.url).toBe('/api/hope/admin/harness/workflows/harness-doc-c1/signal');
            expect(post?.body).toEqual({ signalName: 'approve', payload: { approved: true } });
        });
    });

    it('blocks a signal whose payload is not valid JSON', async () => {
        const calls = stubRoutes();
        renderWithProviders(<HarnessWorkflowsScreen />);
        await selectFirstWorkflow();
        fireEvent.click(screen.getByRole('button', { name: 'Signal' }));
        fireEvent.change(await screen.findByLabelText(/signal name/i), { target: { value: 'approve' } });
        fireEvent.change(screen.getByLabelText(/json payload/i), { target: { value: '{oops' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send signal' }));
        expect(await screen.findByText(/Invalid JSON/)).toBeDefined();
        expect(calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('requires typing the workflow id before terminate fires the POST', async () => {
        const calls = stubRoutes();
        renderWithProviders(<HarnessWorkflowsScreen />);
        await selectFirstWorkflow();
        fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
        const confirm = await screen.findByRole('button', { name: 'Terminate workflow' });
        expect(confirm.hasAttribute('disabled')).toBe(true);

        const input = screen.getByLabelText(/to confirm/i);
        fireEvent.change(input, { target: { value: 'wrong-id' } });
        expect(confirm.hasAttribute('disabled')).toBe(true);

        fireEvent.change(input, { target: { value: 'harness-doc-c1' } });
        expect(confirm.hasAttribute('disabled')).toBe(false);
        fireEvent.click(confirm);

        await waitFor(() => {
            const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/terminate'));
            expect(post?.url).toBe('/api/hope/admin/harness/workflows/harness-doc-c1/terminate');
            expect(post?.body).toEqual({});
        });
    });

    it('gates an elevated session without a working tenant and fires no harness reads', async () => {
        const calls = stubRoutes({ workingTenantId: null });
        renderWithProviders(<HarnessWorkflowsScreen />);
        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.startsWith('/api/hope/admin/harness'))).toBe(true);
    });

    it('shows the error panel with retry when the workflow list fails', async () => {
        stubRoutes({ workflows: Response.json({ statusCode: 503, message: 'temporal unreachable' }, { status: 503 }) });
        renderWithProviders(<HarnessWorkflowsScreen />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Harness Workflows' })).toBeDefined();
        expect(await screen.findByText('temporal unreachable')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    });
});

// The live-refresh predicate that drives `refetchInterval` is a pure function so
// the "poll while a run is live, stop once everything is terminal" rule can be
// asserted deterministically (fake timers race TanStack Query's scheduler).
describe('workflow polling predicate', () => {
    it('treats only RUNNING as a live (non-terminal) Temporal state', () => {
        expect(isNonTerminal('RUNNING')).toBe(true);
        for (const terminal of ['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW']) {
            expect(isNonTerminal(terminal)).toBe(false);
        }
        expect(isNonTerminal(null)).toBe(false);
        expect(isNonTerminal(undefined)).toBe(false);
    });

    it('polls the list on a 5s interval while any visible run is live, else stops', () => {
        expect(workflowsRefetchInterval([summary({ status: 'RUNNING' }), summary({ status: 'FAILED' })])).toBe(5000);
        expect(workflowsRefetchInterval([summary({ status: 'COMPLETED' }), summary({ status: 'FAILED' })])).toBe(false);
        expect(workflowsRefetchInterval([])).toBe(false);
        expect(workflowsRefetchInterval(undefined)).toBe(false);
    });

    it('polls the selected detail only while its run is live', () => {
        expect(workflowRefetchInterval('RUNNING')).toBe(5000);
        expect(workflowRefetchInterval('COMPLETED')).toBe(false);
        expect(workflowRefetchInterval(undefined)).toBe(false);
    });
});
