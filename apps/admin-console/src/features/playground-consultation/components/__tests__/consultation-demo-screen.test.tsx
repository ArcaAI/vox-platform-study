/**
 * Frame 50 — Consultation Demo screen (TASK-432, matrix row 34). The
 * `@arcaai/vox` module is mocked at the boundary (the SDK has its own suite);
 * fetch is stubbed by pathname; SSE via a FakeEventSource global. Covers the
 * NoTenant gate, the setup → open flow, capture wiring (SDK audio.start +
 * recording/start REST with the streaming sessionId), partial-vs-final
 * transcript rows, the live-summary SSE pane incl. the closed terminal state,
 * sync + async generate actions, and the loading/error variants.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConsultationDemoScreen } from '../consultation-demo-screen';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK double models only the consumed surface */
const sdk = vi.hoisted(() => ({
    arca: null as any,
    arcaSession: null as any,
    storeApi: null as any,
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock('@arcaai/vox', () => ({
    AgenticProvider: ({ children }: { children: ReactNode }) => children,
    useArca: () => sdk.arca,
    useArcaSession: () => sdk.arcaSession,
    useStoreApi: () => sdk.storeApi,
}));

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

    emit(type: string, data: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent);
        }
    }

    fail(): void {
        this.onerror?.();
    }
}

const CONSULTATION = {
    id: 'c-1',
    patientId: 'P-448',
    doctorId: 'u-1',
    appointmentDate: '2026-07-06',
    status: 'OPEN',
    createdAt: '2026-07-06T14:02:00.000Z',
    updatedAt: '2026-07-06T14:02:00.000Z',
};

function makeArca() {
    return {
        session: {
            consultation: null,
            relatedConsultations: [],
            isLoading: false,
            error: null,
            open: vi.fn(async (input: { patientId: string }) => {
                const consultation = { ...CONSULTATION, patientId: input.patientId };
                sdk.arca = { ...sdk.arca, session: { ...sdk.arca.session, consultation } };
                return consultation;
            }),
        },
        audio: {
            isCapturing: false,
            isMuted: false,
            level: 0,
            isSpeaking: false,
            currentTranscript: '',
            transcriptSegments: [] as Array<{ text: string; startTime: number; endTime: number; isFinal: boolean; speakerLabel?: string }>,
            language: 'en',
            plugins: {
                noiseFilter: { isActive: true, isSupported: true },
                vad: { isActive: true, isSupported: true },
                stt: { isActive: true, isSupported: true, isProcessing: false },
            },
            error: null as Error | null,
            start: vi.fn(async () => {
                sdk.arca = { ...sdk.arca, audio: { ...sdk.arca.audio, isCapturing: true } };
            }),
            stop: vi.fn(async () => {
                sdk.arca = { ...sdk.arca, audio: { ...sdk.arca.audio, isCapturing: false } };
            }),
        },
        isReady: true,
        error: null,
    };
}

function makeStoreApi(sessionId: string | null = 's-7f31') {
    return {
        getState: () => ({
            pluginManager: {
                getTranscriptionPipeline: () => ({
                    getConfig: () => ({ stt: { streamingTransport: sessionId ? { sessionManager: { getSessionId: () => sessionId } } : undefined } }),
                }),
            },
        }),
    };
}

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'], tenantId: null },
        isElevated: true,
        workingTenantId: 't-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...overrides,
    };
}

const PIPELINES = [
    { id: 'pl-1', name: 'Default Clinical', slug: 'default-clinical', isDefault: true, tags: [] },
    { id: 'pl-2', name: 'Fast Draft', slug: 'fast-draft', isDefault: false, tags: [] },
];

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

type FetchHandler = (call: RecordedCall, parsed: URL) => Response | undefined;

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
            const response = handler(call, new URL(call.url, 'http://test.local'));
            if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
            return response;
        }),
    );
    return calls;
}

function defaultHandler(call: RecordedCall, parsed: URL): Response | undefined {
    const path = parsed.pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/auth/stream-ticket') {
        return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
    }
    if (path === '/api/hope/audio/pipelines') return Response.json(PIPELINES);
    if (path === '/api/hope/consultations/c-1/recording/start') {
        return Response.json({ consultationId: 'c-1', status: 'RECORDING', recording: true, sessionId: 's-7f31', sseUrl: '/x', updatedAt: 'now' });
    }
    if (path === '/api/hope/consultations/c-1/recording/stop') {
        return Response.json({ consultationId: 'c-1', status: 'OPEN', recording: false, sseUrl: '/x', updatedAt: 'now' });
    }
    if (path === '/api/hope/consultations/c-1/summary/async') {
        return Response.json({ jobId: 'j-2210', status: 'pending', consultationId: 'c-1', createdAt: '2026-07-06T14:10:00.000Z' });
    }
    if (path === '/api/hope/consultations/c-1/summary/latest') return Response.json({ message: 'none' }, { status: 404 });
    if (path === '/api/hope/consultations/c-1/summary') {
        return Response.json({
            id: 'ctx-9',
            consultationId: 'c-1',
            type: 'summary',
            content: 'S: Dyspnea on exertion x5 days.',
            createdAt: 'now',
            updatedAt: 'now',
        });
    }
    if (path === '/api/hope/consultations/jobs/j-2210/cancel') return Response.json({ ok: true });
    return undefined;
}

function stubDemo(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call, parsed) => custom(call, parsed) ?? defaultHandler(call, parsed));
}

async function openConsultationFlow(): Promise<void> {
    fireEvent.change(await screen.findByLabelText(/patient id/i), { target: { value: 'P-448' } });
    fireEvent.click(screen.getByRole('button', { name: /open consultation/i }));
    await screen.findByText('c-1');
}

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    sdk.arca = makeArca();
    sdk.arcaSession = {
        close: vi.fn(async () => ({ ...CONSULTATION, status: 'CLOSED' })),
        reopen: vi.fn(async () => ({ ...CONSULTATION, status: 'OPEN' })),
    };
    sdk.storeApi = makeStoreApi();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('ConsultationDemoScreen', () => {
    it('renders the NoTenant gate for an elevated session without a working tenant (no data fetches)', async () => {
        const calls = stubDemo((call, parsed) => {
            if (parsed.pathname === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<ConsultationDemoScreen />);

        expect(await screen.findByRole('heading', { level: 1, name: 'Consultation Demo' })).toBeDefined();
        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        await waitFor(() => expect(calls.some((call) => call.url.includes('/api/auth/session'))).toBe(true));
        expect(calls.some((call) => call.url.includes('audio/pipelines'))).toBe(false);
    });

    it('keeps the layout skeleton while the session is loading', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { container } = renderWithProviders(<ConsultationDemoScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.getByRole('heading', { level: 1, name: 'Consultation Demo' })).toBeDefined();
    });

    it('opens a demo consultation through the SDK: labeled patient input, pipeline picker, status bar', async () => {
        stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);

        // Pipeline picker fed by GET audio/pipelines, defaulting to the tenant default.
        const picker = (await screen.findByLabelText(/transcription pipeline/i)) as HTMLSelectElement;
        expect(within(picker).getByRole('option', { name: /default clinical/i })).toBeDefined();
        expect(within(picker).getByRole('option', { name: /fast draft/i })).toBeDefined();
        await waitFor(() => expect(picker.value).toBe('pl-1'));

        // Required marker on the patient field; empty submit never reaches the SDK.
        fireEvent.click(screen.getByRole('button', { name: /open consultation/i }));
        expect(await screen.findByText(/patient id is required/i)).toBeDefined();
        expect(sdk.arca.session.open).not.toHaveBeenCalled();

        await openConsultationFlow();
        expect(sdk.arca.session.open).toHaveBeenCalledWith({ patientId: 'P-448' });
        // Status bar shows the demo consultation and its lifecycle status.
        expect(screen.getByText('Open')).toBeDefined();
        expect(screen.getByRole('button', { name: /close consultation/i })).toBeDefined();
    });

    it('starts recording: SDK audio.start with the picked pipeline, then recording/start with the streaming sessionId', async () => {
        const calls = stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);

        // Capture controls are gated on an open consultation.
        const start = await screen.findByRole('button', { name: /start recording/i });
        expect(start.hasAttribute('disabled')).toBe(true);
        await openConsultationFlow();

        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));

        await waitFor(() => expect(sdk.arca.audio.start).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pl-1' })));
        await waitFor(() => {
            const startCall = calls.find((call) => call.url.includes('/consultations/c-1/recording/start'));
            expect(startCall?.body).toEqual({ sessionId: 's-7f31' });
        });

        // REC indicator + stop control while capturing; level meter present.
        expect(await screen.findByText(/REC/)).toBeDefined();
        expect(screen.getByRole('meter', { name: /audio level/i })).toBeDefined();
        expect(screen.getByText('Recording')).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
        await waitFor(() => expect(sdk.arca.audio.stop).toHaveBeenCalled());
        await waitFor(() => expect(calls.some((call) => call.url.includes('/consultations/c-1/recording/stop'))).toBe(true));
    });

    it('shows VAD/noise-filter chips and the mic-permission prompt state', async () => {
        stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);

        expect(await screen.findByText('VAD on')).toBeDefined();
        expect(screen.getByText('Noise filter on')).toBeDefined();
        expect(screen.getByText(/mic permission/i)).toBeDefined();
        expect(screen.getByText(/prompt on first start/i)).toBeDefined();
    });

    it('surfaces a denied-microphone capture error with browser-settings guidance', async () => {
        stubDemo();
        const denied = new Error('Permission denied');
        denied.name = 'NotAllowedError';
        sdk.arca = makeArca();
        sdk.arca.audio.error = denied;
        renderWithProviders(<ConsultationDemoScreen />);

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/allow microphone access/i)).toBeDefined();
    });

    it('renders final transcript rows with speakers and the partial row styled with a caret', async () => {
        stubDemo();
        sdk.arca = makeArca();
        sdk.arca.audio.transcriptSegments = [
            { text: 'breathless since Tuesday, worse on exertion.', startTime: 1, endTime: 2, isFinal: true, speakerLabel: 'Doctor' },
            { text: 'It gets tight when I climb the stairs.', startTime: 3, endTime: 4, isFinal: true, speakerLabel: 'Patient' },
        ];
        sdk.arca.audio.currentTranscript = 'I will order an ECG and listen';
        renderWithProviders(<ConsultationDemoScreen />);

        const transcript = await screen.findByRole('list', { name: /transcript/i });
        expect(within(transcript).getByText(/breathless since Tuesday/)).toBeDefined();
        expect(within(transcript).getByText(/climb the stairs/)).toBeDefined();
        expect(within(transcript).getByText('Doctor')).toBeDefined();
        expect(within(transcript).getByText('Patient')).toBeDefined();

        // Partial row: distinct styling hook + caret, no speaker attribution yet.
        const partial = within(transcript).getByText(/order an ECG/).closest('[data-partial="true"]');
        expect(partial).not.toBeNull();
        expect(partial?.textContent).toContain('\u258b');
    });

    it('streams the live summary after recording starts and shows the closed terminal state', async () => {
        stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);
        await openConsultationFlow();
        fireEvent.click(screen.getByRole('button', { name: /start recording/i }));

        // recording/start arms the live-summary stream with the right scope.
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/c-1/live-summary/stream?ticket=');

        const source = FakeEventSource.instances[0];
        source.open();
        source.message({
            consultationId: 'c-1',
            runningSummary: 'Dyspnea on exertion x5 days. ECG ordered.',
            sections: [
                { title: 'Subjective', content: 'Dyspnea on exertion x5 days' },
                { title: 'Plan', content: 'ECG - spirometry - follow-up' },
            ],
            entities: [{ text: 'ECG', type: 'PROCEDURE', confidence: 0.97 }],
            updatedAt: '2026-07-06T14:03:00.000Z',
        });

        expect(await screen.findByText('Subjective')).toBeDefined();
        expect(screen.getByText(/Dyspnea on exertion x5 days/)).toBeDefined();
        expect(screen.getByText(/ECG - spirometry - follow-up/)).toBeDefined();
        expect(screen.getByText('ECG')).toBeDefined();

        source.message({
            consultationId: 'c-1',
            runningSummary: 'final',
            sections: [{ title: 'Running Summary', content: 'final' }],
            entities: [],
            updatedAt: '2026-07-06T14:05:00.000Z',
            closed: true,
        });
        expect(await screen.findByText('Ended')).toBeDefined();
    });

    it('generates the sync summary via POST :id/summary with toast feedback', async () => {
        const { toast } = await import('sonner');
        const calls = stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);
        await openConsultationFlow();

        fireEvent.click(screen.getByRole('button', { name: /generate summary/i }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/hope/consultations/c-1/summary') && !call.url.includes('async'))).toBe(true),
        );
        await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });

    it('runs the async summary job with SSE progress and a cancel action', async () => {
        const calls = stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);
        await openConsultationFlow();

        fireEvent.click(screen.getByRole('button', { name: /generate async job/i }));

        await waitFor(() => expect(calls.some((call) => call.url.includes('/consultations/c-1/summary/async'))).toBe(true));
        // The job strip appears and its SSE stream is scoped to the job.
        expect(await screen.findByText('j-2210')).toBeDefined();
        await waitFor(() => expect(FakeEventSource.instances.some((source) => source.url.includes('/consultations/jobs/j-2210/stream'))).toBe(true));

        const source = FakeEventSource.instances.find((instance) => instance.url.includes('/jobs/j-2210/'))!;
        source.open();
        source.message({ jobId: 'j-2210', status: 'RUNNING', progress: 60, currentStep: 'assembling context' });
        expect(await screen.findByText(/60%/)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /cancel job/i }));
        await waitFor(() =>
            expect(calls.some((call) => call.method === 'PATCH' && call.url.includes('/consultations/jobs/j-2210/cancel'))).toBe(true),
        );
    });

    it('shows the pipelines load failure as a GatewayError message with retry', async () => {
        stubDemo((call, parsed) => {
            if (parsed.pathname === '/api/hope/audio/pipelines') return Response.json({ message: 'Pipelines unreachable' }, { status: 503 });
            return undefined;
        });
        renderWithProviders(<ConsultationDemoScreen />);

        expect(await screen.findByText(/pipelines unreachable/i)).toBeDefined();
        expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    });

    it('switches to the Documentation Review tab (frame 50.1)', async () => {
        stubDemo();
        renderWithProviders(<ConsultationDemoScreen />);
        await openConsultationFlow();

        // Radix tab triggers select on mousedown (not click).
        const reviewTab = screen.getByRole('tab', { name: /documentation review/i });
        fireEvent.mouseDown(reviewTab);
        fireEvent.click(reviewTab);
        expect(await screen.findByText('Harness progress')).toBeDefined();
    });
});
