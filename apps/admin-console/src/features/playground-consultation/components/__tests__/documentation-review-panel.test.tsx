/**
 * Frame 50.1 — Documentation Review phase. Exercises the harness
 * stage checklist (progress SSE), per-claim assurance verdicts + gate
 * decision + flagged-claim chip (assurance SSE), the draft-note pane with
 * provenance, and the approve & sign-off success path. fetch stubbed by
 * pathname; streams via a FakeEventSource global.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { DocumentationReviewPanel } from '../documentation-review-panel';

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
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

    message(data: unknown): void {
        this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }

    emit(type: string, data: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener({ data: JSON.stringify(data) } as MessageEvent);
        }
    }
}

const DRAFT = {
    id: 'ctx-9',
    consultationId: 'c-1',
    type: 'summary',
    content: 'S: Dyspnea on exertion, chest pressure without radiation.\nP: ECG - spirometry - review 1 wk',
    structuredData: { llmProvider: 'openai', modelName: 'gpt-4o', processingTimeMs: 8125 },
    createdAt: '2026-07-06T14:10:00.000Z',
    updatedAt: '2026-07-06T14:10:00.000Z',
};

const NER = {
    consultationId: 'c-1',
    scope: 'single',
    entities: { PROCEDURE: [{ id: 'ne-1', text: 'ECG', displayText: 'ECG' }] },
    totalCount: 5,
    countByClass: { PROCEDURE: 1, CONDITION: 4 },
    sources: [],
};

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
    if (path === '/api/auth/stream-ticket') {
        return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
    }
    if (path === '/api/hope/consultations/c-1/summary/latest') return Response.json(DRAFT);
    if (path === '/api/hope/consultations/c-1/named-entities') return Response.json(NER);
    if (path === '/api/hope/consultations/c-1/summary/ctx-9/approve') {
        return Response.json({ contextItemId: 'ctx-9', approvalStatus: 'APPROVED', approvedBy: 'u-1', approvedAt: '2026-07-06T15:00:00.000Z' });
    }
    return undefined;
}

function stubReview(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call, parsed) => custom(call, parsed) ?? defaultHandler(call, parsed));
}

function sourceFor(fragment: string): FakeEventSource {
    const source = FakeEventSource.instances.find((instance) => instance.url.includes(fragment));
    if (!source) throw new Error(`No EventSource opened for ${fragment}`);
    return source;
}

async function waitForStreams(): Promise<void> {
    await waitFor(() => {
        expect(FakeEventSource.instances.some((source) => source.url.includes('/harness-progress/'))).toBe(true);
        expect(FakeEventSource.instances.some((source) => source.url.includes('/harness-assurance/'))).toBe(true);
    });
}

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('DocumentationReviewPanel', () => {
    it('opens both harness streams and renders the stage checklist from the progress snapshot', async () => {
        stubReview();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" />);
        await waitForStreams();

        expect(sourceFor('/harness-progress/').url).toContain('/api/v1/consultations/c-1/harness-progress/stream?ticket=');
        expect(sourceFor('/harness-assurance/').url).toContain('/api/v1/consultations/c-1/harness-assurance/stream?ticket=');

        const progress = sourceFor('/harness-progress/');
        progress.open();
        progress.message({
            consultationId: 'c-1',
            total: 5,
            stages: [
                { stage: 'extracting_information', label: 'Context assembled', ordinal: 1, status: 'completed', attempt: 1, at: 't' },
                { stage: 'assembling_context', label: 'Entities extracted', ordinal: 2, status: 'completed', attempt: 1, at: 't' },
                { stage: 'drafting_note', label: 'Draft generated', ordinal: 3, status: 'completed', attempt: 1, at: 't' },
                { stage: 'running_safety_sensors', label: 'Assurance running', ordinal: 4, status: 'active', attempt: 1, at: 't' },
                { stage: 'finalizing_draft', label: 'Gate decision', ordinal: 5, status: 'pending', attempt: 1, at: 't' },
            ],
            updatedAt: 't',
            closed: false,
        });

        const checklist = await screen.findByRole('list', { name: /harness stages/i });
        const items = within(checklist).getAllByRole('listitem');
        expect(items).toHaveLength(5);
        expect(items[0].textContent).toContain('Context assembled');
        expect(items[3].textContent).toContain('Assurance running');
        // Stage progress meta + the review-gate indicator while the run is live.
        expect(screen.getByText(/stage 4\/5/i)).toBeDefined();
        expect(screen.getByText(/review gate/i)).toBeDefined();
    });

    it('renders per-claim verdicts (PASS / REVIEW / running), the gate decision and the flagged-claim chip', async () => {
        stubReview();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" />);
        await waitForStreams();

        const assurance = sourceFor('/harness-assurance/');
        assurance.open();
        assurance.message({
            consultationId: 'c-1',
            total: 5,
            claims: [
                { claimId: 'C-01', sensor: 'groundedness', verdict: 'grounded', label: 'Dyspnea x5 days', ordinal: 1, at: 't' },
                { claimId: 'C-02', sensor: 'citation_verify', verdict: 'pass', label: 'ECG ordered', ordinal: 2, at: 't' },
                { claimId: 'C-03', sensor: 'groundedness', verdict: 'ungrounded', label: 'No smoking history', ordinal: 3, at: 't' },
                { claimId: 'C-04', sensor: 'safety', verdict: 'flag', label: 'Spirometry plan', ordinal: 4, at: 't' },
            ],
            updatedAt: 't',
            closed: false,
        });

        const claims = await screen.findByRole('list', { name: /claim verdicts/i });
        expect(within(claims).getAllByText('PASS')).toHaveLength(2);
        expect(within(claims).getAllByText('REVIEW')).toHaveLength(2);
        expect(within(claims).getByText('C-01')).toBeDefined();
        // 4 of 5 claims resolved — the outstanding claim renders a running row.
        expect(within(claims).getByText(/running/i)).toBeDefined();

        // Terminal event: gate decision + safety flag chip.
        assurance.emit('assurance_complete', {
            consultationId: 'c-1',
            total: 5,
            claims: [
                { claimId: 'C-01', sensor: 'groundedness', verdict: 'grounded', ordinal: 1, at: 't' },
                { claimId: 'C-02', sensor: 'citation_verify', verdict: 'pass', ordinal: 2, at: 't' },
                { claimId: 'C-03', sensor: 'groundedness', verdict: 'ungrounded', ordinal: 3, at: 't' },
                { claimId: 'C-04', sensor: 'safety', verdict: 'flag', ordinal: 4, at: 't' },
                { claimId: 'C-05', sensor: 'safety', verdict: 'pass', ordinal: 5, at: 't' },
            ],
            gateDecision: 'FLAG',
            safetyFlag: true,
            reducedAssurance: false,
            updatedAt: 't',
            closed: true,
        });

        expect(await screen.findByText(/gate: flag/i)).toBeDefined();
        expect(screen.getByText(/claim flagged/i)).toBeDefined();
        // The safety override control appears only for flagged notes.
        expect(screen.getByLabelText(/override safety flag/i)).toBeDefined();
    });

    it('shows the draft note with provenance meta from the latest summary', async () => {
        stubReview();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" />);

        expect(await screen.findByText(/dyspnea on exertion, chest pressure/i)).toBeDefined();
        expect(screen.getByText(/openai/)).toBeDefined();
        expect(screen.getByText(/gpt-4o/)).toBeDefined();
        // Named entities meta rides along (GET :id/named-entities).
        expect(await screen.findByText(/5 entities/i)).toBeDefined();
    });

    it('approves the draft: POST :id/summary/:contextItemId/approve with success toast', async () => {
        const { toast } = await import('sonner');
        const calls = stubReview();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" />);

        const approve = await screen.findByRole('button', { name: /approve & sign-off/i });
        fireEvent.click(approve);

        await waitFor(() => {
            const call = calls.find((recorded) => recorded.url.includes('/summary/ctx-9/approve'));
            expect(call?.method).toBe('POST');
            expect(call?.body).toEqual({});
        });
        await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });

    it('passes overrideSafetyFlag only when the flagged-note override is checked', async () => {
        const calls = stubReview();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" />);
        await waitForStreams();

        const assurance = sourceFor('/harness-assurance/');
        assurance.open();
        assurance.emit('assurance_complete', {
            consultationId: 'c-1',
            total: 1,
            claims: [{ claimId: 'C-04', sensor: 'safety', verdict: 'flag', ordinal: 1, at: 't' }],
            gateDecision: 'FLAG',
            safetyFlag: true,
            updatedAt: 't',
            closed: true,
        });

        fireEvent.click(await screen.findByLabelText(/override safety flag/i));
        fireEvent.click(screen.getByRole('button', { name: /approve & sign-off/i }));

        await waitFor(() => {
            const call = calls.find((recorded) => recorded.url.includes('/summary/ctx-9/approve'));
            expect(call?.body).toEqual({ overrideSafetyFlag: true });
        });
    });

    it('renders the nothing-to-review empty state with a back-to-demo action when no draft exists', async () => {
        stubReview((call, parsed) => {
            if (parsed.pathname === '/api/hope/consultations/c-1/summary/latest') return Response.json({ message: 'none' }, { status: 404 });
            return undefined;
        });
        const onBackToDemo = vi.fn();
        renderWithProviders(<DocumentationReviewPanel consultationId="c-1" onBackToDemo={onBackToDemo} />);

        expect(await screen.findByText(/no draft awaiting review/i)).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /back to consultation demo/i }));
        expect(onBackToDemo).toHaveBeenCalled();
    });
});
