/**
 * TASK-433 — frame 51 Live Transcription screen. fetch, EventSource and the
 * audio SDK modules are all stubbed: the WS leg drives through a fake
 * `SttV2WebSocketClient`, capture through a fake `@arcaai/stt`, SSE through a
 * FakeEventSource. Covers the NoTenant gate, the 429 quota panel, the
 * partial-vs-final transcript stream, batch multipart upload + job SSE panel
 * and the my-jobs strip with cancel/retry.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { PlaygroundTranscriptionJob } from '../../api/types';
import { LiveTranscriptionScreen } from '../live-transcription-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const { FakeSttWsClient, capture } = vi.hoisted(() => {
    type Handler = (payload?: unknown) => void;

    class FakeSttWsClient {
        static instances: FakeSttWsClient[] = [];
        connectedUrl: string | null = null;
        disconnected = false;
        stopSent = false;
        sentFrames: Array<ArrayBuffer | ArrayBufferView> = [];
        handlers: Record<string, Handler> = {};
        reconnect: { enabled?: boolean; refreshTicket?: () => Promise<string> } | undefined;
        private connected = false;

        constructor(...args: unknown[]) {
            FakeSttWsClient.instances.push(this);
            this.reconnect = args[1] as FakeSttWsClient['reconnect'];
        }

        async connect(url: string): Promise<void> {
            this.connectedUrl = url;
            this.connected = true;
        }
        disconnect(): void {
            this.disconnected = true;
            this.connected = false;
        }
        isConnected(): boolean {
            return this.connected;
        }
        sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean {
            this.sentFrames.push(data);
            return true;
        }
        sendStop(): void {
            this.stopSent = true;
        }
        onTranscript(cb: Handler): void {
            this.handlers.transcript = cb;
        }
        onStatus(cb: Handler): void {
            this.handlers.status = cb;
        }
        onWsError(cb: Handler): void {
            this.handlers.wsError = cb;
        }
        onDisconnect(cb: Handler): void {
            this.handlers.disconnect = cb;
        }
        onReconnect(cb: Handler): void {
            this.handlers.reconnect = cb;
        }
        onReconnectFailed(cb: Handler): void {
            this.handlers.reconnectFailed = cb;
        }
    }

    const capture = {
        onFrame: null as ((frame: Float32Array) => void) | null,
        destroy: vi.fn(),
        setEnabled: vi.fn(),
    };

    return { FakeSttWsClient, capture };
});

vi.mock('@arcaai/vox/core', () => ({ SttV2WebSocketClient: FakeSttWsClient }));

vi.mock('@arcaai/stt', () => ({
    createAudioCapture: vi.fn(async (_ctx: unknown, _track: unknown, onFrame: (frame: Float32Array) => void) => {
        capture.onFrame = onFrame;
        return { usesWorklet: true, destroy: capture.destroy, setEnabled: capture.setEnabled };
    }),
    float32ToInt16: vi.fn((frame: Float32Array) => new Int16Array(frame.length)),
}));

/** Instrumented EventSource double (pattern from transcription-jobs-screen.test.tsx). */
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
                body: init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            };
            calls.push(call);
            const response = handler(call);
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function session(overrides: Partial<{ workingTenantId: string | null; tenantId: string | null }> = {}) {
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'], tenantId: overrides.tenantId ?? null },
        isElevated: true,
        workingTenantId: 'workingTenantId' in overrides ? overrides.workingTenantId : 'tnt-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
    };
}

function job(overrides: Partial<PlaygroundTranscriptionJob> = {}): PlaygroundTranscriptionJob {
    return {
        id: 'j-run',
        jobType: 'BATCH',
        pipelineId: 'p-default',
        status: 'PROCESSING',
        progress: 40,
        queuedAt: '2026-07-06T06:00:00.000Z',
        startedAt: '2026-07-06T06:01:00.000Z',
        completedAt: null,
        errorMessage: null,
        errorCode: null,
        retryCount: 0,
        maxRetries: 3,
        createdAt: '2026-07-06T06:00:00.000Z',
        updatedAt: '2026-07-06T06:02:00.000Z',
        ...overrides,
    };
}

const JOBS: PlaygroundTranscriptionJob[] = [
    job(),
    job({ id: 'j-old-1', status: 'FAILED', completedAt: '2026-07-06T06:10:00.000Z', errorMessage: 'Decoder crashed', errorCode: 'DECODER_ERROR' }),
];

const PIPELINES = [
    { id: 'p-default', name: 'Default Clinical', slug: 'default-clinical', isDefault: true, resourceStatus: 'ENABLED' },
    { id: 'p-cardio', name: 'Cardio', slug: 'cardio', isDefault: false, resourceStatus: 'ENABLED' },
];

const SESSION_RESPONSE = {
    sessionId: 's-9d42',
    status: 'created',
    wsUrl: '/ws/stt-v2/stream',
    maxConcurrent: 5,
    currentActive: 1,
    ticket: 'tkt-abc',
    ticketExpiresAt: Date.now() + 30_000,
    voiceProfileSeeded: true,
};

function defaultHandler(call: RecordedCall): Response | undefined {
    const path = new URL(call.url, 'http://test.local').pathname;
    if (call.method === 'POST' && path === '/api/auth/stream-ticket') {
        return Response.json({ ticket: 'tkt-sse', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
    }
    if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/stream/session') {
        return Response.json(SESSION_RESPONSE, { status: 201 });
    }
    if (call.method === 'DELETE' && path === '/api/hope/audio/transcription-jobs/stream/session/s-9d42') {
        return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/transcribe') {
        return Response.json(
            { id: 'j-8841', status: 'QUEUED', sseUrl: '/api/v1/audio/transcription-jobs/j-8841/stream', audioUri: 's3://bucket/raw/visit.wav' },
            { status: 201 },
        );
    }
    if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/j-run/cancel') {
        return Response.json(job({ status: 'CANCELLED' }));
    }
    if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/j-old-1/retry') {
        return Response.json(job({ id: 'j-old-1', status: 'QUEUED' }));
    }
    if (call.method !== 'GET') return undefined;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/audio/pipelines') return Response.json(PIPELINES);
    if (path === '/api/hope/audio/transcription-jobs') {
        return Response.json({ data: JOBS, total: 2, page: 1, limit: 20, totalPages: 1 });
    }
    if (path === '/api/hope/audio/transcription-jobs/j-8841') {
        return Response.json(job({ id: 'j-8841', status: 'QUEUED', progress: 0 }));
    }
    return undefined;
}

function stubScreen(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

const micTrack = { label: 'MacBook Pro Mic', stop: vi.fn() };

beforeEach(() => {
    FakeSttWsClient.instances = [];
    FakeEventSource.instances = [];
    capture.onFrame = null;
    capture.destroy.mockClear();
    micTrack.stop.mockClear();

    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
        'AudioContext',
        class {
            state = 'running';
            close = vi.fn(async () => {});
        },
    );
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: vi.fn(async () => ({
                getAudioTracks: () => [micTrack],
                getTracks: () => [micTrack],
            })),
        },
    });
});

afterEach(() => {
    // Unmount while fetch is still stubbed: teardown of a live session fires
    // the end-session DELETE, which must hit the stub rather than the network.
    cleanup();
    vi.unstubAllGlobals();
});

async function startSession() {
    fireEvent.click(screen.getAllByRole('button', { name: /start session/i })[0]);
    await waitFor(() => expect(FakeSttWsClient.instances.length).toBe(1));
    return FakeSttWsClient.instances[0];
}

describe('LiveTranscriptionScreen', () => {
    it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
        const calls = stubScreen((call) => {
            const path = new URL(call.url, 'http://test.local').pathname;
            if (path === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<LiveTranscriptionScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.includes('/audio/'))).toBe(true);
    });

    it('renders both tabs, defaults the pipeline picker to the tenant default and shows the streaming empty state', async () => {
        stubScreen();
        renderWithProviders(<LiveTranscriptionScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Live Transcription' })).toBeDefined();
        // The gate's loading branch renders the h1 first — wait for the tab list.
        expect(await screen.findByRole('tab', { name: /streaming/i })).toBeDefined();
        expect(screen.getByRole('tab', { name: /batch upload/i })).toBeDefined();

        // Canvas-header subtitle (TASK-442 §4: the playground banner moved to the
        // top-bar persona control — no page-level statusBanner strip here).
        expect(screen.getByText(/Streaming session .* runs under your own account/)).toBeDefined();

        const picker = (await screen.findByLabelText('Pipeline')) as HTMLSelectElement;
        await waitFor(() => expect(picker.value).toBe('p-default'));

        expect(screen.getByText('No live session')).toBeDefined();
    });

    it('starts a session against the selected pipeline and streams the WS transcript (partial caret row, then final)', async () => {
        const calls = stubScreen();
        renderWithProviders(<LiveTranscriptionScreen />);
        await screen.findByLabelText('Pipeline');

        const ws = await startSession();

        // Session create carried the picker's pipeline; WS carries the tenant claim.
        const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/stream/session'));
        expect((create?.body as { pipelineId: string }).pipelineId).toBe('p-default');
        expect(ws.connectedUrl).toContain('sessionId=s-9d42');
        expect(ws.connectedUrl).toContain('ticket=tkt-abc');
        expect(ws.connectedUrl).toContain('tenantId=tnt-1');

        // Live chip + session meta from the 201 payload.
        expect(await screen.findByText('Streaming')).toBeDefined();
        expect(screen.getByText('Voice profile seeded')).toBeDefined();
        expect(screen.getByText(/1\/5/)).toBeDefined();

        act(() => ws.handlers.transcript?.({ type: 'transcript', text: 'worse after long screen time', isFinal: false, startTime: 21, endTime: 23, seq: 46 }));
        const transcript = within(screen.getByRole('log', { name: /live transcript/i }));
        expect(transcript.getByText(/worse after long screen time/)).toBeDefined();
        expect(transcript.getByText('partial')).toBeDefined();

        act(() =>
            ws.handlers.transcript?.({
                type: 'transcript',
                text: 'Patient reports morning headaches.',
                isFinal: true,
                startTime: 21,
                endTime: 24,
                seq: 47,
                inference: 0.32,
            }),
        );
        expect(transcript.getByText('Patient reports morning headaches.')).toBeDefined();
        expect(transcript.getByText('final')).toBeDefined();
        expect(transcript.queryByText('partial')).toBeNull();
        // Footer meta: seq + latency.
        expect(screen.getByText(/seq 47/)).toBeDefined();
        expect(screen.getByText(/~320 ms/)).toBeDefined();
    });

    it('renders the designed 429 quota panel when the tenant is at maxConcurrentSessions', async () => {
        stubScreen((call) => {
            const path = new URL(call.url, 'http://test.local').pathname;
            if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/stream/session') {
                return Response.json(
                    { statusCode: 429, message: 'Tenant is at its concurrent streaming session limit', error: 'Too Many Requests' },
                    { status: 429 },
                );
            }
            return undefined;
        });
        renderWithProviders(<LiveTranscriptionScreen />);
        await screen.findByLabelText('Pipeline');

        fireEvent.click(screen.getAllByRole('button', { name: /start session/i })[0]);

        expect(await screen.findByText('Session quota reached')).toBeDefined();
        expect(screen.getByText(/429/)).toBeDefined();
        expect(screen.getByText(/maxConcurrentSessions/)).toBeDefined();
        expect(FakeSttWsClient.instances).toHaveLength(0);
    });

    // Batch flows deep-link `?tab=batch` (harness-policy test pattern): the nuqs
    // testing adapter is memoryless, so a clicked tab reverts on the next queue
    // flush — under the real Next adapter the URL write persists.
    it('uploads a batch file as multipart and follows the job through its SSE stream', async () => {
        const calls = stubScreen();
        renderWithProviders(<LiveTranscriptionScreen />, { searchParams: '?tab=batch' });
        await screen.findByLabelText('Pipeline');

        const file = new File(['RIFF'.repeat(64)], 'visit.wav', { type: 'audio/wav' });
        const input = (await screen.findByLabelText(/audio file/i)) as HTMLInputElement;
        fireEvent.change(input, { target: { files: [file] } });

        // Rule 9: chosen file shows name + size + a remove control.
        expect(await screen.findByText('visit.wav')).toBeDefined();
        expect(screen.getByRole('button', { name: /remove file/i })).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /upload & transcribe/i }));

        // Multipart body through the BFF: file + pipelineId fields.
        await waitFor(() => {
            const upload = calls.find((call) => call.url === '/api/hope/audio/transcription-jobs/transcribe');
            expect(upload).toBeDefined();
            expect(upload?.body).toBeInstanceOf(FormData);
            expect((upload?.body as FormData).get('pipelineId')).toBe('p-default');
            expect(((upload?.body as FormData).get('file') as File).name).toBe('visit.wav');
        });

        // Job card opens its scoped SSE stream straight against the gateway.
        await waitFor(() => {
            const mint = calls.find((call) => call.url === '/api/auth/stream-ticket');
            expect(mint?.body).toEqual({ scope: 'transcription_job:j-8841' });
        });
        await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/audio/transcription-jobs/j-8841/stream?ticket=');

        const card = within(await screen.findByRole('region', { name: /active batch job/i }));
        expect(card.getByText('j-8841')).toBeDefined();

        act(() => FakeEventSource.instances[0].open());
        act(() => FakeEventSource.instances[0].emit('progress', JSON.stringify({ type: 'progress', data: { jobId: 'j-8841', progress: 62 } })));
        expect(await card.findByText(/62%/)).toBeDefined();
    });

    it('lists my jobs with cancel/retry actions wired to the owner-scoped mutations', async () => {
        const calls = stubScreen();
        renderWithProviders(<LiveTranscriptionScreen />, { searchParams: '?tab=batch' });
        await screen.findByLabelText('Pipeline');

        const strip = within(await screen.findByRole('region', { name: /my jobs/i }));
        expect(await strip.findByText('j-run')).toBeDefined();
        expect(strip.getByText('j-old-1')).toBeDefined();

        fireEvent.click(strip.getByRole('button', { name: 'Cancel job j-run' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/audio/transcription-jobs/j-run/cancel'))).toBe(true));

        fireEvent.click(strip.getByRole('button', { name: 'Retry job j-old-1' }));
        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/audio/transcription-jobs/j-old-1/retry'))).toBe(true),
        );
    });

    it('shows the jobs-strip empty state when the caller has no jobs yet', async () => {
        stubScreen((call) => {
            const path = new URL(call.url, 'http://test.local').pathname;
            if (call.method === 'GET' && path === '/api/hope/audio/transcription-jobs') {
                return Response.json({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });
            }
            return undefined;
        });
        renderWithProviders(<LiveTranscriptionScreen />, { searchParams: '?tab=batch' });
        await screen.findByLabelText('Pipeline');

        expect(await screen.findByText('No batch jobs yet')).toBeDefined();
    });
});
