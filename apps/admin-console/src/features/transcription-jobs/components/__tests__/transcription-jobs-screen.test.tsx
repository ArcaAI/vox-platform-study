/**
 * Frame 35 — Transcription jobs screen. fetch AND EventSource are stubbed;
 * assertions cover the stats cards, the failed-card filter shortcut, job
 * selection opening the stream panel (ticket mint + direct-gateway
 * EventSource), the NoTenant gate and the block error state.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TranscriptionJob, TranscriptionJobStats } from '../../api/types';
import { TranscriptionJobsScreen } from '../transcription-jobs-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

/** Instrumented EventSource double (pattern from use-event-stream.test.tsx). */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly url: string;
    readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(name: string, listener: (event: MessageEvent) => void): void {
        const existing = this.listeners.get(name) ?? [];
        this.listeners.set(name, [...existing, listener]);
    }

    close(): void {
        this.closed = true;
    }

    open(): void {
        this.onopen?.();
    }

    emit(type: string, data: string): void {
        const event = { data } as MessageEvent;
        if (type === 'message') {
            this.onmessage?.(event);
            return;
        }
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function job(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
    return {
        id: 'job-9f2ka7c3',
        jobType: 'BATCH',
        pipelineId: 'p-1',
        consultationId: null,
        contextItemId: null,
        mediaId: 'm-1',
        status: 'PROCESSING',
        progress: 60,
        queuedAt: '2026-07-05T06:00:00.000Z',
        startedAt: '2026-07-05T06:01:00.000Z',
        completedAt: null,
        resultText: null,
        resultMetadata: null,
        errorMessage: null,
        errorCode: null,
        retryCount: 0,
        maxRetries: 3,
        workerId: 'w-1',
        tenantId: 'tnt-1',
        createdAt: '2026-07-05T06:00:00.000Z',
        updatedAt: '2026-07-05T06:02:00.000Z',
        createdBy: 'u-1',
        ...overrides,
    };
}

const JOBS: TranscriptionJob[] = [
    job(),
    job({
        id: 'job-5k3vn8d4',
        status: 'FAILED',
        completedAt: '2026-07-05T06:13:00.000Z',
        errorMessage: 'Decoder crashed',
        errorCode: 'DECODER_ERROR',
    }),
];

const STATS: TranscriptionJobStats = { queued: 12, processing: 3, completed: 194, failed: 4, cancelled: 0, dead: 0 };

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const call: RecordedCall = {
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const response = handler(call);
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'] },
        isElevated: true,
        workingTenantId: 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...overrides,
    };
}

function defaultHandler(call: RecordedCall): Response | undefined {
    const path = new URL(call.url, 'http://test.local').pathname;
    if (call.method === 'POST' && path === '/api/auth/stream-ticket') {
        return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
    }
    if (call.method !== 'GET') return undefined;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/admin/audio/transcription-jobs') {
        return Response.json({ data: JOBS, total: 214, page: 1, limit: 25, totalPages: 9 });
    }
    if (path === '/api/hope/admin/audio/transcription-jobs/stats') return Response.json(STATS);
    if (path === '/api/hope/admin/audio/transcription-jobs/status/FAILED') return Response.json([JOBS[1]]);
    if (path === '/api/hope/audio/transcription-jobs/job-9f2ka7c3') return Response.json(JOBS[0]);
    if (path === '/api/hope/audio/transcription-jobs/job-5k3vn8d4') return Response.json(JOBS[1]);
    return undefined;
}

/** Best-effort per-user grid-layout persistence (`user/me/settings`) — no saved layout in tests. */
function settingsResponse(call: RecordedCall): Response | undefined {
    if (!call.url.includes('/user/me/settings')) return undefined;
    return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
}

function stubJobs(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => settingsResponse(call) ?? custom(call) ?? defaultHandler(call));
}

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
});

describe('TranscriptionJobsScreen', () => {
    it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
        const calls = stubJobs((call) => {
            const path = new URL(call.url, 'http://test.local').pathname;
            if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<TranscriptionJobsScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.includes('/transcription-jobs'))).toBe(true);
    });

    it('renders the four stat cards from GET stats and the header job count', async () => {
        stubJobs();
        renderWithProviders(<TranscriptionJobsScreen />);

        const stats = within(await screen.findByRole('region', { name: 'Job status counts' }));
        expect(await stats.findByText('12')).toBeDefined();
        expect(stats.getByText('3')).toBeDefined();
        expect(stats.getByText('194')).toBeDefined();
        expect(stats.getByText('4')).toBeDefined();
        expect(stats.getByText('Queued')).toBeDefined();
        expect(stats.getByText('Running')).toBeDefined();
        expect(stats.getByText('Completed')).toBeDefined();
        // Header meta count = sum of the stats buckets (12 + 3 + 194 + 4).
        expect(await screen.findByText(/213 jobs/)).toBeDefined();
    });

    it('routes the failed stat card shortcut into the typed-filter (`f`) url param', async () => {
        stubJobs();
        const onUrlUpdate = vi.fn();
        renderWithProviders(<TranscriptionJobsScreen />, { onUrlUpdate });

        expect(await screen.findByText('job-9f2ka7c3')).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /filter the grid to failed jobs/i }));

        // The Status filter now travels in the compact `f` param (JSON tuples), not a
        // discrete `status` key — the shortcut writes the FAILED select rule.
        await waitFor(() => {
            const update = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams } | undefined;
            const f = update?.searchParams.get('f');
            expect(f).toBeTruthy();
            expect(JSON.parse(f as string)).toEqual([['status', 'eq', 'select', 'FAILED']]);
        });
    });

    it('drives the grid from GET status/:status while the FAILED filter is active', async () => {
        const f = encodeURIComponent(JSON.stringify([['status', 'eq', 'select', 'FAILED']]));
        const calls = stubJobs();
        renderWithProviders(<TranscriptionJobsScreen />, { searchParams: `?f=${f}` });

        expect(await screen.findByText('job-5k3vn8d4')).toBeDefined();
        expect(screen.queryByText('job-9f2ka7c3')).toBeNull();
        expect(calls.some((call) => call.url.includes('/admin/audio/transcription-jobs/status/FAILED'))).toBe(true);
        // The unfiltered paginated list stays parked while the filter is on.
        expect(
            calls.some((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/audio/transcription-jobs'),
        ).toBe(false);
    });

    it('opens the stream panel on row click: detail loads and the SSE connects with a scoped ticket', async () => {
        const calls = stubJobs();
        renderWithProviders(<TranscriptionJobsScreen />);

        fireEvent.click(await screen.findByText('job-9f2ka7c3'));

        // Detail read renders the mono job facts (one-shot; re-polls only if the stream errors).
        expect(await screen.findByText('p-1')).toBeDefined();
        expect(await screen.findByText('60%')).toBeDefined();

        // Ticket minted for the job-scoped stream, EventSource opened directly
        // against the gateway (never the BFF proxy).
        await waitFor(() => {
            const mint = calls.find((call) => call.url === '/api/auth/stream-ticket');
            expect(mint?.body).toEqual({ scope: 'transcription_job:job-9f2ka7c3' });
        });
        await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/audio/transcription-jobs/job-9f2ka7c3/stream?ticket=tkt-1');

        act(() => FakeEventSource.instances[0].open());
        expect(await screen.findByText('Live')).toBeDefined();

        act(() => FakeEventSource.instances[0].emit('status', '{"status":"PROCESSING"}'));
        expect(await screen.findByText('[status]')).toBeDefined();
        expect(screen.getByText('{"status":"PROCESSING"}')).toBeDefined();
    });

    it('renders the block error state when the jobs read fails (stats keep their last value)', async () => {
        stubJobs((call) => {
            if (call.method === 'GET' && new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/audio/transcription-jobs') {
                return Response.json({ message: 'Service unavailable' }, { status: 503 });
            }
            return undefined;
        });
        renderWithProviders(<TranscriptionJobsScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();
        // The stats strip still renders from its own read.
        expect(await screen.findByText('194')).toBeDefined();
    });
});
