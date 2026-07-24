/**
 * Frames 50 + 50.1 — console SSE panes. The gateway streams publish FULL-STATE
 * snapshots (clients stay stateless), so the folding hooks keep only the
 * latest accepted event and close on `closed: true` (single-use tickets — no
 * zombie sources). Live summary / harness progress arrive as default
 * `message` events; the assurance terminal aggregate ALSO rides the named
 * `assurance_complete` event. The async-summary job hook mirrors
 * useDnaJobProgress: SSE primary (`consultation_job:<jobId>` scope, default
 * messages with UPPERCASE states), 2s poll fallback only after the stream
 * exhausts its retry budget.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useHarnessAssuranceStream,
    useHarnessProgressStream,
    useSummaryJobProgress,
} from '../hooks';
import type { ConsultationJobStatus } from '../types';

/** Instrumented EventSource double (mirrors the use-event-stream test). */
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
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }

    close(): void {
        this.closed = true;
    }

    open(): void {
        this.onopen?.();
    }

    /** Default (unnamed) SSE message. */
    message(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }

    /** Named SSE event (e.g. `assurance_complete`). */
    emit(type: string, data: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent);
        }
    }

    fail(): void {
        this.onerror?.();
    }
}

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

/** Answers the ticket mint and the job-status poll; everything else throws. */
function stubNetwork(jobStatus: () => Response = () => Response.json({})): RecordedCall[] {
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
            if (call.url === '/api/auth/stream-ticket') {
                return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
            }
            if (call.url.includes('/jobs/')) return jobStatus();
            throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
        }),
    );
    return calls;
}

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    return { queryClient, Wrapper };
}

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('useHarnessProgressStream', () => {
    it('mints a consultation_harness_progress ticket and folds the stage checklist', async () => {
        const calls = stubNetwork();
        const { Wrapper } = createWrapper();
        const { result } = renderHook(() => useHarnessProgressStream('c-1', true), { wrapper: Wrapper });

        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        expect(calls.find((call) => call.url === '/api/auth/stream-ticket')?.body).toEqual({ scope: 'consultation_harness_progress:c-1' });
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/c-1/harness-progress/stream?ticket=');

        act(() =>
            FakeEventSource.instances[0].message({
                consultationId: 'c-1',
                stages: [
                    { stage: 'extracting_information', label: 'Entities extracted', ordinal: 1, status: 'completed', attempt: 1, at: 't' },
                    { stage: 'running_safety_sensors', label: 'Assurance running', ordinal: 4, status: 'active', attempt: 1, at: 't' },
                ],
                updatedAt: 't',
                closed: false,
            }),
        );
        expect(result.current.snapshot?.stages).toHaveLength(2);
        expect(result.current.snapshot?.stages[1].status).toBe('active');
    });
});

describe('useHarnessAssuranceStream', () => {
    it('folds claim verdicts from message events and the terminal named assurance_complete event', async () => {
        const calls = stubNetwork();
        const { Wrapper } = createWrapper();
        const { result } = renderHook(() => useHarnessAssuranceStream('c-1', true), { wrapper: Wrapper });

        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        expect(calls.find((call) => call.url === '/api/auth/stream-ticket')?.body).toEqual({ scope: 'consultation_harness_assurance:c-1' });
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/c-1/harness-assurance/stream?ticket=');

        const source = FakeEventSource.instances[0];
        act(() =>
            source.message({
                consultationId: 'c-1',
                claims: [{ claimId: 'C-01', sensor: 'groundedness', verdict: 'grounded', label: 'Dyspnea x5 days', ordinal: 1, at: 't' }],
                updatedAt: 't',
                closed: false,
            }),
        );
        expect(result.current.snapshot?.claims[0].verdict).toBe('grounded');

        // Terminal aggregate on the NAMED event: gate decision + safety flag + close.
        act(() =>
            source.emit('assurance_complete', {
                consultationId: 'c-1',
                claims: [
                    { claimId: 'C-01', sensor: 'groundedness', verdict: 'grounded', at: 't' },
                    { claimId: 'C-04', sensor: 'safety', verdict: 'flag', at: 't' },
                ],
                gateDecision: 'FLAG',
                safetyFlag: true,
                updatedAt: 't',
                closed: true,
            }),
        );
        await waitFor(() => expect(source.closed).toBe(true));
        expect(result.current.snapshot?.gateDecision).toBe('FLAG');
        expect(result.current.snapshot?.safetyFlag).toBe(true);
        expect(result.current.snapshot?.claims).toHaveLength(2);
    });
});

const runningJob = (progress: number): ConsultationJobStatus => ({ jobId: 'j-1', type: 'SUMMARY', status: 'RUNNING', progress });

describe('useSummaryJobProgress', () => {
    it('mints a consultation_job ticket, folds default message events and fires onTerminal once on COMPLETED', async () => {
        const calls = stubNetwork(() => Response.json(runningJob(10)));
        const { Wrapper } = createWrapper();
        const onTerminal = vi.fn();
        const { result } = renderHook(() => useSummaryJobProgress('j-1', { onTerminal }), { wrapper: Wrapper });

        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        expect(calls.find((call) => call.url === '/api/auth/stream-ticket')?.body).toEqual({ scope: 'consultation_job:j-1' });
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/jobs/j-1/stream?ticket=');

        const source = FakeEventSource.instances[0];
        act(() => {
            source.open();
            source.message({ ...runningJob(40), currentStep: 'Generating summary' });
        });
        expect(result.current.job).toMatchObject({ jobId: 'j-1', status: 'RUNNING', progress: 40, currentStep: 'Generating summary' });
        expect(result.current.isTerminal).toBe(false);
        expect(result.current.streamStatus).toBe('open');

        act(() => source.message({ jobId: 'j-1', type: 'SUMMARY', status: 'COMPLETED', progress: 100, contextItemId: 'ctx-9' }));
        await waitFor(() => expect(result.current.isTerminal).toBe(true));
        expect(result.current.job?.status).toBe('COMPLETED');
        // Terminal messages must stop the stream (single-use tickets, no zombies).
        expect(source.closed).toBe(true);
        await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
        expect(onTerminal.mock.calls[0][0]).toMatchObject({ status: 'COMPLETED' });

        // SSE is the primary transport — the fallback poll never fired.
        expect(calls.every((call) => call.url === '/api/auth/stream-ticket')).toBe(true);
    });

    it('falls back to the 2s status poll ONLY after the stream exhausts its retry budget', async () => {
        vi.useFakeTimers();
        const calls = stubNetwork(() => Response.json({ jobId: 'j-1', type: 'SUMMARY', status: 'COMPLETED', progress: 100 }));
        const { Wrapper } = createWrapper();
        const onTerminal = vi.fn();
        const { result } = renderHook(() => useSummaryJobProgress('j-1', { onTerminal }), { wrapper: Wrapper });

        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        // While the stream is still retrying, no status poll is issued.
        expect(calls.filter((call) => call.url.includes('/jobs/'))).toHaveLength(0);

        // Drive the stream through its retry budget (3 reconnects, linear backoff).
        for (let round = 0; round < 4; round += 1) {
            act(() => FakeEventSource.instances.at(-1)?.fail());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(4_000);
            });
        }

        await vi.waitFor(() => expect(result.current.isTerminal).toBe(true));
        expect(calls.filter((call) => call.url.includes('/jobs/')).length).toBeGreaterThan(0);
        expect(result.current.job).toMatchObject({ status: 'COMPLETED', progress: 100 });
        await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    });

    it('is idle without a job id and resets folded state when the job changes', async () => {
        const calls = stubNetwork(() => Response.json(runningJob(10)));
        const { Wrapper } = createWrapper();
        const { result, rerender } = renderHook(({ jobId }: { jobId: string | null }) => useSummaryJobProgress(jobId), {
            wrapper: Wrapper,
            initialProps: { jobId: null as string | null },
        });

        expect(result.current.job).toBeNull();
        expect(result.current.streamStatus).toBe('idle');
        expect(calls).toHaveLength(0);

        rerender({ jobId: 'j-1' });
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        act(() => FakeEventSource.instances[0].message(runningJob(80)));
        expect(result.current.job?.progress).toBe(80);

        rerender({ jobId: null });
        expect(result.current.job).toBeNull();
        expect(result.current.streamStatus).toBe('idle');
    });
});
