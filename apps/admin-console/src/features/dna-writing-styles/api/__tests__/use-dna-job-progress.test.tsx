/**
 * useDnaJobProgress — the SSE + 2s-poll merge for DNA generation jobs. The
 * stream side is exercised through a stubbed global EventSource (ticket mint
 * asserted with scope `dna_job:<id>`); the poll side through the stubbed
 * fetch. Polling is what carries progress TODAY: the gateway stream route has
 * no @StreamScope yet (TASK-419), so tickets 401 in real deployments.
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
});

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
    });

    it('reaches terminal through the poll alone when the stream never delivers (TASK-419 gap)', async () => {
        stubNetwork(() => Response.json({ jobId: 'j-1', status: 'completed', progress: 100, result: null }));
        const { Wrapper } = createWrapper();
        const onTerminal = vi.fn();
        const { result } = renderHook(() => useDnaJobProgress('j-1', { onTerminal }), { wrapper: Wrapper });

        // The stream connects but no event ever arrives — polling must win.
        await waitFor(() => expect(result.current.isTerminal).toBe(true));
        expect(result.current.job).toMatchObject({ jobId: 'j-1', status: 'completed', progress: 100 });
        await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
        // The terminal effect also closes the stream on the poll-detected end.
        await waitFor(() => expect(FakeEventSource.instances.at(0)?.closed).toBe(true));
    });

    it('merges both transports, newest snapshot winning', async () => {
        stubNetwork(() => Response.json(processing(40)));
        const { Wrapper } = createWrapper();
        const { result } = renderHook(() => useDnaJobProgress('j-1'), { wrapper: Wrapper });

        // Poll lands first (progress 40)...
        await waitFor(() => expect(result.current.job?.progress).toBe(40));
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

        // ...then a fresher SSE status supersedes it.
        act(() => FakeEventSource.instances[0].emit('status', JSON.stringify(processing(70))));
        expect(result.current.job?.progress).toBe(70);
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
