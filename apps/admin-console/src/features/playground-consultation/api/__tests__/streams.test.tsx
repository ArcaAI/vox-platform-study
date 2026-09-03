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
import { useDocumentSectionsStream, useHarnessAssuranceStream, useHarnessProgressStream, useLiveAssistStream, useSummaryJobProgress } from '../hooks';
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

describe('useLiveAssistStream', () => {
  it('mints a consultation_live_assist ticket and keeps suggestions/corrections in separate branches (RC-2)', async () => {
    const calls = stubNetwork();
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useLiveAssistStream('c-1', true), { wrapper: Wrapper });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(calls.find((call) => call.url === '/api/auth/stream-ticket')?.body).toEqual({ scope: 'consultation_live_assist:c-1' });
    expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/c-1/live-assist/stream?ticket=');

    expect(result.current.suggestions).toEqual([]);
    expect(result.current.corrections).toBeNull();

    act(() =>
      FakeEventSource.instances[0].message({
        kind: 'suggestions',
        nodeType: 'nlp.clinical_suggestions',
        provider: 'lmstudio',
        model: 'gemma3',
        suggestions: [{ suggestionId: 's-1', text: 'Consider ordering a chest X-ray', status: 'PROPOSED', proposedBy: 'lmstudio:gemma3' }],
      }),
    );
    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestionsNodeType).toBe('nlp.clinical_suggestions');
    // A suggestions publish must never touch the corrections branch.
    expect(result.current.corrections).toBeNull();

    act(() =>
      FakeEventSource.instances[0].message({
        kind: 'corrections',
        nodeType: 'nlp.correction_proposals',
        corrections: {
          proposals: [
            {
              proposalId: 'p-1',
              start: 10,
              end: 16,
              original: 'Toprovol',
              proposed: 'Toprol',
              category: 'drugName',
              confidence: 0.92,
              rationale: 'Common ASR misrecognition of a beta-blocker name',
              detectedBy: 'nlp.ner',
              proposedBy: 'lmstudio:gemma3',
              status: 'PROPOSED',
            },
          ],
          applied: false,
          appliedCount: 0,
          textSha256: 'abc123',
        },
      }),
    );
    expect(result.current.corrections?.proposals).toHaveLength(1);
    expect(result.current.correctionsNodeType).toBe('nlp.correction_proposals');
    // A corrections publish must never clobber the suggestions branch.
    expect(result.current.suggestions).toHaveLength(1);
  });

  it('resets both branches when the consultation id changes', async () => {
    stubNetwork();
    const { Wrapper } = createWrapper();
    const { result, rerender } = renderHook(({ consultationId }: { consultationId: string | null }) => useLiveAssistStream(consultationId, true), {
      wrapper: Wrapper,
      initialProps: { consultationId: 'c-1' as string | null },
    });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instances[0].message({
        kind: 'suggestions',
        nodeType: 'nlp.clinical_suggestions',
        suggestions: [{ suggestionId: 's-1', text: 'x', status: 'PROPOSED' }],
      }),
    );
    expect(result.current.suggestions).toHaveLength(1);

    rerender({ consultationId: 'c-2' });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.corrections).toBeNull();
  });
});

describe('useDocumentSectionsStream (DD-3 / DD-3 — N documents)', () => {
  it('groups section.patch events by documentKey, in idx order within each document', async () => {
    const calls = stubNetwork();
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useDocumentSectionsStream('c-1', true), { wrapper: Wrapper });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // Reuses the SAME scope/path as the legacy live-summary snapshot — section.patch is an
    // ADDITIVE second event on that stream, not a new one.
    expect(calls.find((call) => call.url === '/api/auth/stream-ticket')?.body).toEqual({ scope: 'consultation_live_summary:c-1' });
    expect(FakeEventSource.instances[0].url).toContain('/api/v1/consultations/c-1/live-summary/stream?ticket=');

    const source = FakeEventSource.instances[0];
    act(() =>
      source.message({
        event: 'section.patch',
        consultationId: 'c-1',
        documentKey: 'soap_note',
        sectionKey: 'assessment',
        title: 'Assessment',
        idx: 1,
        revision: 1,
        state: 'provisional',
        content: 'Hypertension, well controlled.',
        updatedAt: 't1',
      }),
    );
    act(() =>
      source.message({
        event: 'section.patch',
        consultationId: 'c-1',
        documentKey: 'soap_note',
        sectionKey: 'subjective',
        title: 'Subjective',
        idx: 0,
        revision: 1,
        state: 'confirmed',
        content: 'Patient reports feeling well.',
        updatedAt: 't2',
      }),
    );
    act(() =>
      source.message({
        event: 'section.patch',
        consultationId: 'c-1',
        documentKey: 'discharge_summary',
        sectionKey: 'plan',
        title: 'Plan',
        idx: 0,
        revision: 1,
        state: 'empty',
        content: '',
        updatedAt: 't3',
      }),
    );

    expect(result.current.documents.map((d) => d.documentKey)).toEqual(['soap_note', 'discharge_summary']);
    const soap = result.current.documents[0];
    // idx order WITHIN the document, regardless of arrival order.
    expect(soap.sections.map((s) => s.sectionKey)).toEqual(['subjective', 'assessment']);
    expect(soap.sections[0].state).toBe('confirmed');
    expect(soap.sections[1].state).toBe('provisional');
    expect(result.current.documents[1].sections[0].state).toBe('empty');

    // A full-state live-summary snapshot (the LEGACY, undiscriminated payload) on the SAME
    // stream must never be mistaken for a section patch.
    act(() => source.message({ consultationId: 'c-1', runningSummary: 'x', sections: [], entities: [], updatedAt: 't4' }));
    expect(result.current.documents.map((d) => d.documentKey)).toEqual(['soap_note', 'discharge_summary']);
  });

  it('discards a patch whose revision is not greater than the one already held (out-of-order delivery)', async () => {
    stubNetwork();
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useDocumentSectionsStream('c-1', true), { wrapper: Wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() =>
      source.message({
        event: 'section.patch',
        consultationId: 'c-1',
        documentKey: 'soap_note',
        sectionKey: 'assessment',
        title: 'Assessment',
        idx: 0,
        revision: 5,
        state: 'confirmed',
        content: 'Latest.',
        updatedAt: 't2',
      }),
    );
    act(() =>
      source.message({
        event: 'section.patch',
        consultationId: 'c-1',
        documentKey: 'soap_note',
        sectionKey: 'assessment',
        title: 'Assessment',
        idx: 0,
        revision: 3,
        state: 'provisional',
        content: 'Stale — arrived late.',
        updatedAt: 't1',
      }),
    );

    expect(result.current.documents[0].sections[0]).toMatchObject({ revision: 5, state: 'confirmed', content: 'Latest.' });
  });

  it('resets when the consultation id changes', async () => {
    stubNetwork();
    const { Wrapper } = createWrapper();
    const { result, rerender } = renderHook(({ consultationId }: { consultationId: string | null }) => useDocumentSectionsStream(consultationId, true), {
      wrapper: Wrapper,
      initialProps: { consultationId: 'c-1' as string | null },
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => sendSectionPatch(FakeEventSource.instances[0], 'soap_note', 'assessment'));
    expect(result.current.documents).toHaveLength(1);

    rerender({ consultationId: 'c-2' });
    expect(result.current.documents).toEqual([]);
  });
});

function sendSectionPatch(source: InstanceType<typeof FakeEventSource>, documentKey: string, sectionKey: string): void {
  source.message({
    event: 'section.patch',
    consultationId: 'c-1',
    documentKey,
    sectionKey,
    title: sectionKey,
    idx: 0,
    revision: 1,
    state: 'provisional',
    content: 'x',
    updatedAt: 't',
  });
}
