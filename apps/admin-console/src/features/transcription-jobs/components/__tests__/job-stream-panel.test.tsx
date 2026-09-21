/**
 * TASK-999 — the panel must never let the shared SSE hook's reconnect loop run forever on a
 * terminal transcription job. Covers the two cases named in the ticket:
 *   A. a terminal `status` frame closes the stream and schedules no reconnect.
 *   B. a job that is ALREADY terminal at mount never opens a stream at all.
 * D is the paired regression: a non-terminal `status` frame must not trip the same close path.
 *
 * fetch + EventSource stubbing mirrors `use-event-stream.test.tsx` and the sibling
 * `transcription-jobs-screen.test.tsx` (same FakeEventSource shape, same stubbed BFF routes).
 */

import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { TranscriptionJob } from '../../api/types';
import { JobStreamPanel } from '../job-stream-panel';

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
    id: 'job-1',
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

/** Stubs exactly the two BFF routes `JobStreamPanel` can call: the ticket mint and the detail read. */
function stubJob(current: TranscriptionJob) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url, 'http://test.local').pathname;
      if (init?.method === 'POST' && path === '/api/auth/stream-ticket') {
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as { scope: string }) : { scope: '' };
        return Response.json({ ticket: 'tkt-1', expiresAt: Date.now() + 30_000, scope: body.scope });
      }
      if ((!init?.method || init.method === 'GET') && path === `/api/hope/audio/transcription-jobs/${current.id}`) {
        return Response.json(current);
      }
      throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
    }),
  );
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('JobStreamPanel', () => {
  it('A: a terminal `status` frame closes the stream and schedules no reconnect', async () => {
    // BEFORE the fix: the panel never inspected incoming events, so this exact
    // `{"type":"status","data":{"status":"COMPLETED"}}` frame (the shape
    // `TranscriptionRealtimeService` actually sends) left the connection open; the gateway then
    // ended the response, `onerror` fired, and — compounded by the shared hook's
    // reset-on-`onopen` bug — it reconnected forever instead of ever settling.
    stubJob(job({ status: 'PROCESSING' }));
    renderWithProviders(<JobStreamPanel jobId="job-1" />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.open());
    expect(await screen.findByText('Live')).toBeDefined();

    act(() => source.emit('message', JSON.stringify({ type: 'status', data: { jobId: 'job-1', status: 'COMPLETED' } })));

    await waitFor(() => expect(source.closed).toBe(true));
    // A closed stream settles on `closed`, never `connecting`/`error` — and schedules no
    // reconnect, so a second EventSource is never opened.
    expect(await screen.findByText('Closed')).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('D: a non-terminal `status` frame does NOT close the stream (regression)', async () => {
    stubJob(job({ status: 'PROCESSING' }));
    renderWithProviders(<JobStreamPanel jobId="job-1" />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source.open());
    expect(await screen.findByText('Live')).toBeDefined();

    act(() => source.emit('message', JSON.stringify({ type: 'status', data: { jobId: 'job-1', status: 'PROCESSING' } })));

    expect(source.closed).toBe(false);
    expect(screen.getByText('Live')).toBeDefined();
  });

  it('B: a job already terminal at mount never opens a stream at all', async () => {
    // BEFORE the fix: the panel subscribed unconditionally regardless of the job's REST status,
    // hitting the gateway's "already finished" branch (`TranscriptionRealtimeService
    // .subscribeToJob`) immediately on mount — the exact reconnect loop from the bug report,
    // starting from the very first render.
    stubJob(job({ status: 'COMPLETED', completedAt: '2026-07-05T06:10:00.000Z' }));
    renderWithProviders(<JobStreamPanel jobId="job-1" />);

    // The final REST state renders — no subscription needed to show it.
    expect(await screen.findByText('p-1')).toBeDefined();
    expect(screen.getByText('Idle')).toBeDefined();

    // Give any (incorrect) subscription attempt a beat to fire before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
