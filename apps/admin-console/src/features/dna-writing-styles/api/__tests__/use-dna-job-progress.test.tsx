/**
 * useDnaJobProgress — ticket-authenticated SSE is the PRIMARY transport
 * (the gateway route declares @StreamScope dna_job); the 2s
 * status poll is the documented error fallback, enabled only after the
 * stream exhausts its retry budget. The stream side is exercised through a
 * stubbed global EventSource (ticket mint asserted with scope
 * `dna_job:<id>`); the fallback poll through the stubbed fetch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDnaJobProgress } from '../hooks';
import type { DnaJobStatus } from '../types';

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
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data } as MessageEvent);
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
function stubNetwork(jobStatus: () => Response): RecordedCall[] {
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
                return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: 'dna_job:j-1' });
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

const processing = (progress: number): DnaJobStatus => ({ jobId: 'j-1', status: 'processing', progress });

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/**
 * Drives the stream through its full retry budget (3 reconnects, linear
 * backoff, each minting a fresh ticket) so the hook lands on `error` and the
 * fallback poll becomes eligible.
 */
async function exhaustStreamRetries(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
        act(() => FakeEventSource.instances.at(-1)?.fail());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_000);
        });
    }
}

describe('useDnaJobProgress', () => {
    it('mints a dna_job-scoped ticket, folds SSE events and closes on the terminal result', async () => {
        const calls = stubNetwork(() => Response.json(processing(10)));
        const { Wrapper } = createWrapper();
        const onTerminal = vi.fn();
        const { result } = renderHook(() => useDnaJobProgress('j-1', { onTerminal }), { wrapper: Wrapper });

        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        const mint = calls.find((call) => call.url === '/api/auth/stream-ticket');
        expect(mint?.body).toEqual({ scope: 'dna_job:j-1' });
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/admin/dna-writing-styles/jobs/j-1/stream?ticket=');

        const source = FakeEventSource.instances[0];
        act(() => {
            source.open();
            source.emit('status', JSON.stringify(processing(40)));
        });
        expect(result.current.job).toEqual(processing(40));
        expect(result.current.streamStatus).toBe('open');

        act(() => source.emit('progress', JSON.stringify({ jobId: 'j-1', progress: 60 })));
        expect(result.current.job?.progress).toBe(60);
        expect(result.current.isTerminal).toBe(false);

        act(() => source.emit('result', JSON.stringify({ reportId: 'rep-9' })));
        await waitFor(() => expect(result.current.isTerminal).toBe(true));
        expect(result.current.job).toMatchObject({ jobId: 'j-1', status: 'completed', progress: 100, result: { reportId: 'rep-9' } });
        // Terminal events must stop the stream (single-use tickets, no zombies).
        expect(source.closed).toBe(true);
        await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
        expect(onTerminal.mock.calls[0][0]).toMatchObject({ status: 'completed' });

        // SSE is the primary transport: the fallback poll never fired, so the
        // only network traffic besides the stream itself is the ticket mint.
        expect(calls.every((call) => call.url === '/api/auth/stream-ticket')).toBe(true);
    });

    it('falls back to the 2s poll ONLY after the stream exhausts its retry budget', async () => {
        vi.useFakeTimers();
        const calls = stubNetwork(() => Response.json({ jobId: 'j-1', status: 'completed', progress: 100, result: null }));
        const { Wrapper } = createWrapper();
        const onTerminal = vi.fn();
        const { result } = renderHook(() => useDnaJobProgress('j-1', { onTerminal }), { wrapper: Wrapper });

        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        // While the stream is still trying, no status poll is issued.
        expect(calls.filter((call) => call.url.includes('/jobs/'))).toHaveLength(0);

        await exhaustStreamRetries();

        // Stream landed on error -> the fallback poll takes over and delivers
        // the terminal state end-to-end (invalidation + onTerminal + close).
        await vi.waitFor(() => expect(result.current.isTerminal).toBe(true));
        expect(calls.filter((call) => call.url.includes('/jobs/')).length).toBeGreaterThan(0);
        expect(result.current.job).toMatchObject({ jobId: 'j-1', status: 'completed', progress: 100 });
        await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    });

    it('a fresher fallback-poll snapshot supersedes the last pre-error SSE snapshot', async () => {
        vi.useFakeTimers();
        stubNetwork(() => Response.json(processing(70)));
        const { Wrapper } = createWrapper();
        const { result } = renderHook(() => useDnaJobProgress('j-1'), { wrapper: Wrapper });

        // The stream delivers progress 40, then drops for good.
        await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        act(() => {
            FakeEventSource.instances[0].open();
            FakeEventSource.instances[0].emit('status', JSON.stringify(processing(40)));
        });
        expect(result.current.job?.progress).toBe(40);

        await exhaustStreamRetries();

        // The fallback poll's newer snapshot (70) wins the merge.
        await vi.waitFor(() => expect(result.current.job?.progress).toBe(70));
        expect(result.current.isTerminal).toBe(false);
    });

    it('is idle without a job id and resets folded state when the job changes', async () => {
        const calls = stubNetwork(() => Response.json(processing(10)));
        const { Wrapper } = createWrapper();
        const { result, rerender } = renderHook(({ jobId }: { jobId: string | null }) => useDnaJobProgress(jobId), {
            wrapper: Wrapper,
            initialProps: { jobId: null as string | null },
        });

        expect(result.current.job).toBeNull();
        expect(result.current.streamStatus).toBe('idle');
        expect(calls).toHaveLength(0);

        rerender({ jobId: 'j-1' });
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        act(() => FakeEventSource.instances[0].emit('status', JSON.stringify(processing(80))));
        expect(result.current.job?.progress).toBe(80);

        rerender({ jobId: null });
        expect(result.current.job).toBeNull();
        expect(result.current.streamStatus).toBe('idle');
    });
});
