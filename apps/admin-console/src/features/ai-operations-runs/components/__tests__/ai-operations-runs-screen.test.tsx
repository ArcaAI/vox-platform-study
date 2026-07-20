/**
 * TDD screen tests screen 1 (AI Operations — Runs): the session
 * list, the ordered step timeline with per-step GenerationStats, the HARNESS_DOC
 * cancel action (workflow-ops), the gate-queue tab, the working-tenant gate and
 * axe-cleanliness — against a URL-branching fetch stub. Live SSE stays off (no
 * EventSource) so these tests exercise the read plane deterministically.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GateQueue, TrajectorySession, TrajectoryStep } from '../../api/types';
import { AiOperationsRunsScreen } from '../ai-operations-runs-screen';


vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const SESSIONS: TrajectorySession[] = [
    { sessionId: 'wf-1', runId: 'run-1', sessionKind: 'HARNESS_DOC', consultationId: 'c-1', stepCount: 2, firstStepAt: '2026-07-01T00:00:00.000Z', lastStepAt: '2026-07-01T00:05:00.000Z' },
    { sessionId: 'live-9', runId: '', sessionKind: 'LIVE_DOC', consultationId: 'c-2', stepCount: 1, firstStepAt: '2026-07-01T00:00:00.000Z', lastStepAt: '2026-07-01T00:01:00.000Z' },
];

function step(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
    return {
        id: 'st-1',
        tenantId: 'tnt-1',
        consultationId: 'c-1',
        sessionKind: 'HARNESS_DOC',
        sessionId: 'wf-1',
        runId: 'run-1',
        seq: 1,
        stepType: 'PHASE',
        name: 'NER',
        status: 'OK',
        startedAt: '2026-07-01T00:00:00.000Z',
        endedAt: '2026-07-01T00:00:01.000Z',
        durationMs: 1000,
        stats: null,
        errorCode: null,
        correlationId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        ...overrides,
    };
}

const STEPS: TrajectoryStep[] = [
    step(),
    step({
        id: 'st-2',
        seq: 2,
        stepType: 'LLM_CALL',
        name: 'generate',
        stats: { ttftMs: 120, tokensPerSecond: 45.2, stopReason: 'stop', model: 'gemma-4-medical' },
    }),
];

const GATE_QUEUE: GateQueue = {
    items: [
        {
            consultationId: 'c-1',
            status: 'PENDING_REVIEW',
            pendingSince: '2026-07-01T00:00:00.000Z',
            ageSeconds: 120,
            generateCount: 2,
            regenCount: 1,
            slaDueAt: '2026-07-02T00:00:00.000Z',
            escalationDueAt: '2026-07-01T12:00:00.000Z',
            slaBreached: false,
            escalated: false,
        },
    ],
    total: 1,
    slaBreachedCount: 0,
    escalatedCount: 0,
    gateSlaSeconds: 86400,
    gateEscalationSeconds: 43200,
    policySource: 'tenant',
};

const SESSION = {
    user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
    isElevated: true,
    workingTenantId: 'tnt-1' as string | null,
    workingTenantName: 'Sunrise Medical Group' as string | null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
    effectiveIsElevated: true,
    effectiveTenantId: 'tnt-1' as string | null,
};

interface RecordedCall {
    url: string;
    path: string;
    method: string;
    headers: Headers;
    body: unknown;
}

interface StubOptions {
    session?: typeof SESSION;
    custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, custom }: StubOptions = {}): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const call: RecordedCall = {
                url,
                path: url.split('?')[0],
                method: init?.method ?? 'GET',
                headers: new Headers(init?.headers),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const handled = custom?.(call);
            if (handled) return handled;
            if (call.path === '/api/auth/session') return Response.json(session);
            if (call.method === 'GET' && call.path === '/api/hope/admin/agent-trajectory/sessions') {
                return Response.json({ items: SESSIONS, total: SESSIONS.length });
            }
            if (call.method === 'GET' && call.path === '/api/hope/admin/agent-trajectory/sessions/wf-1/steps') {
                return Response.json({ items: STEPS, nextCursor: null, hasMore: false, limit: 50 });
            }
            if (call.method === 'GET' && call.path === '/api/hope/admin/harness/gate-queue') {
                return Response.json(GATE_QUEUE);
            }
            throw new Error(`Unhandled fetch: ${call.method} ${call.path}`);
        }),
    );
    return calls;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('AiOperationsRunsScreen', () => {
    it('lists sessions and shows the ordered step timeline with per-step stats on select', async () => {
        stubFetch();
        renderWithProviders(<AiOperationsRunsScreen />);

        expect(screen.getByRole('heading', { level: 1, name: 'AI Operations — Runs' })).toBeDefined();
        await screen.findByRole('list', { name: 'Agentic sessions' });
        fireEvent.click(screen.getByRole('button', { name: /wf-1/ }));

        expect(await screen.findByRole('list', { name: 'Trajectory steps for wf-1' })).toBeDefined();
        expect(screen.getByText('generate')).toBeDefined();
        // GenerationStats grid renders known keys.
        expect(screen.getByText('TTFT')).toBeDefined();
        expect(screen.getByText('120 ms')).toBeDefined();
        expect(screen.getByText('tok/s')).toBeDefined();
    });

    it('cancels a HARNESS_DOC run through the workflow-ops proxy', async () => {
        const calls = stubFetch({
            custom: (call) => {
                if (call.method === 'POST' && call.path === '/api/hope/admin/harness/workflows/wf-1/cancel') {
                    return Response.json({ workflowId: 'wf-1', runId: 'run-1', status: 'RUNNING', action: 'cancel', requested: true });
                }
                return undefined;
            },
        });
        renderWithProviders(<AiOperationsRunsScreen />);

        await screen.findByRole('list', { name: 'Agentic sessions' });
        fireEvent.click(screen.getByRole('button', { name: /wf-1/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Cancel run/ }));
        // Confirm inside the alert dialog (the trigger button shares the label).
        const dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));

        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.path).toBe('/api/hope/admin/harness/workflows/wf-1/cancel');
    });

    it('renders the gate queue on its tab', async () => {
        stubFetch();
        renderWithProviders(<AiOperationsRunsScreen />, { searchParams: '?tab=gate-queue' });

        expect(await screen.findByRole('table', { name: 'Gate queue' })).toBeDefined();
        expect(screen.getByText('c-1')).toBeDefined();
        expect(screen.getByText('1 pending')).toBeDefined();
    });

    it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
        stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
        renderWithProviders(<AiOperationsRunsScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(screen.queryByRole('list', { name: 'Agentic sessions' })).toBeNull();
    });

    it('has no axe violations on the session list + timeline', async () => {
        stubFetch();
        const { container } = renderWithProviders(<AiOperationsRunsScreen />);
        await screen.findByRole('list', { name: 'Agentic sessions' });
        fireEvent.click(screen.getByRole('button', { name: /wf-1/ }));
        await screen.findByRole('list', { name: 'Trajectory steps for wf-1' });
        expect(await axe(container)).toHaveNoViolations();
    });
});
