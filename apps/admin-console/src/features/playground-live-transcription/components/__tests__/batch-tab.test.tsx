/**
 * BUG-014 — rule 11 §5: "disabled buttons need a visible reason (tooltip or
 * adjacent text)". `Upload & transcribe` is disabled until BOTH a file and a
 * pipeline exist; with the pipeline picker stalled, `pipelineId` stays null and
 * the control is permanently dead. The reason must be visible AND programmatically
 * associated with the button.
 *
 * TASK-605 — the tab now takes MANY files: one queue row (and one backend job)
 * per file, a bounded number in flight at a time, and a master/detail transcript
 * panel fed either by a queue row or by a past job from the recent-jobs table.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PlaygroundTranscriptionJob } from '../../api/types';
import { BatchTab } from '../batch-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Instrumented EventSource double (pattern from live-transcription-screen.test.tsx). */
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

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent;
    if (type === 'message') {
      this.onmessage?.(event);
      return;
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface RecordedCall {
  url: string;
  path: string;
  method: string;
  body: unknown;
}

let calls: RecordedCall[] = [];
let uploadCount = 0;
/** Held while a test needs uploads to stay in flight (concurrency/cancel). */
let uploadGate: Promise<void> | null = null;
let releaseUploads: () => void = () => {};

function job(overrides: Partial<PlaygroundTranscriptionJob> = {}): PlaygroundTranscriptionJob {
  return {
    id: 'j-run',
    jobType: 'BATCH',
    pipelineId: 'p-default',
    status: 'COMPLETED',
    progress: 100,
    queuedAt: '2026-08-03T06:00:00.000Z',
    startedAt: '2026-08-03T06:01:00.000Z',
    completedAt: '2026-08-03T06:05:00.000Z',
    resultText: 'Authoritative transcript for j-run.',
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    maxRetries: 3,
    createdAt: '2026-08-03T06:00:00.000Z',
    updatedAt: '2026-08-03T06:05:00.000Z',
    ...overrides,
  };
}

let listRows: PlaygroundTranscriptionJob[] = [];

function gateUploads() {
  uploadGate = new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });
}

/** Rejects when the caller aborts, so `cancel` behaves like a real fetch abort. */
function abortSignalPromise(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  });
}

beforeEach(() => {
  calls = [];
  uploadCount = 0;
  uploadGate = null;
  listRows = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url, 'http://test.local').pathname;
      const call: RecordedCall = {
        url,
        path,
        method: init?.method ?? 'GET',
        body: init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);

      if (call.method === 'POST' && path === '/api/auth/stream-ticket') {
        return Response.json({ ticket: 'tkt-sse', expiresAt: Date.now() + 30_000, scope: (call.body as { scope: string }).scope });
      }
      if (call.method === 'POST' && path === '/api/hope/audio/transcription-jobs/transcribe') {
        uploadCount += 1;
        const id = `j-${uploadCount}`;
        if (uploadGate) await Promise.race([uploadGate, abortSignalPromise(init?.signal)]);
        return Response.json({ id, status: 'QUEUED', sseUrl: `/api/v1/audio/transcription-jobs/${id}/stream`, audioUri: `s3://raw/${id}` }, { status: 201 });
      }
      if (call.method === 'POST' && path.endsWith('/cancel')) {
        return Response.json(job({ id: path.split('/').at(-2) as string, status: 'CANCELLED' }));
      }
      if (call.method === 'GET' && path === '/api/hope/audio/transcription-jobs') {
        return Response.json({ data: listRows, total: listRows.length, page: 1, limit: 20, totalPages: 1 });
      }
      if (call.method === 'GET' && path.startsWith('/api/hope/audio/transcription-jobs/')) {
        const id = path.split('/').at(-1) as string;
        return Response.json(job({ id, resultText: `Authoritative transcript for ${id}.` }));
      }
      throw new Error(`Unhandled fetch: ${call.method} ${url}`);
    }),
  );
});

afterEach(() => {
  releaseUploads();
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab(pipelineId: string | null) {
  return renderWithProviders(<BatchTab pipelineId={pipelineId} />);
}

function audioFile(name: string) {
  return new File(['RIFF'.repeat(64)], name, { type: 'audio/wav' });
}

function chooseFiles(...names: string[]) {
  const input = screen.getByLabelText(/audio files?/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: names.map(audioFile) } });
}

function chooseFile() {
  chooseFiles('visit.wav');
}

function uploadButton() {
  return screen.getByRole('button', { name: /upload & transcribe/i }) as HTMLButtonElement;
}

/** The visible text the disabled control points at, via aria-describedby. */
function accessibleReason(): string {
  const id = uploadButton().getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return document.getElementById(id as string)?.textContent ?? '';
}

function queuePanel() {
  return within(screen.getByRole('region', { name: /batch queue/i }));
}

function resultPanel() {
  return within(screen.getByRole('region', { name: /transcript/i }));
}

/** Enqueue `names` and wait until every row exists. */
async function enqueue(...names: string[]) {
  chooseFiles(...names);
  fireEvent.click(uploadButton());
  await waitFor(() => expect(queuePanel().getAllByRole('listitem')).toHaveLength(names.length));
}

function transcribeCalls() {
  return calls.filter((call) => call.path === '/api/hope/audio/transcription-jobs/transcribe');
}

describe('BatchTab upload control', () => {
  it('states that a pipeline is required when the picker produced none', () => {
    renderTab(null);
    chooseFile();

    expect(uploadButton().disabled).toBe(true);
    expect(accessibleReason()).toMatch(/pipeline/i);
  });

  it('states that a file is required when none has been chosen', () => {
    renderTab('p-default');

    expect(uploadButton().disabled).toBe(true);
    expect(accessibleReason()).toMatch(/audio file/i);
  });

  it('drops the reason once the control is actionable', () => {
    renderTab('p-default');
    chooseFile();

    expect(uploadButton().disabled).toBe(false);
    expect(uploadButton().getAttribute('aria-describedby')).toBeNull();
  });
});

describe('BatchTab multi-file selection', () => {
  it('stages every chosen file, each with its own remove control', () => {
    renderTab('p-default');
    chooseFiles('one.wav', 'two.wav', 'three.wav');

    expect(screen.getByText('one.wav')).toBeDefined();
    expect(screen.getByText('two.wav')).toBeDefined();
    expect(screen.getByText('three.wav')).toBeDefined();
    expect(screen.getByRole('button', { name: /remove file two\.wav/i })).toBeDefined();
  });

  it('accepts a multi-file drop on the drag zone', () => {
    renderTab('p-default');
    const zone = screen.getByTestId('batch-drop-zone');
    fireEvent.drop(zone, { dataTransfer: { files: [audioFile('drop-a.wav'), audioFile('drop-b.wav')] } });

    expect(screen.getByText('drop-a.wav')).toBeDefined();
    expect(screen.getByText('drop-b.wav')).toBeDefined();
  });

  it('rejects an oversized file by name and keeps the valid ones', () => {
    renderTab('p-default');
    const big = new File(['x'], 'huge.wav', { type: 'audio/wav' });
    Object.defineProperty(big, 'size', { value: 200 * 1024 * 1024 });
    const input = screen.getByLabelText(/audio files?/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [audioFile('ok.wav'), big] } });

    expect(screen.getByText('ok.wav')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toMatch(/huge\.wav/);
  });

  it('creates one queue row per file and, over the run, one upload per row', async () => {
    renderTab('p-default');
    await enqueue('a.wav', 'b.wav', 'c.wav');

    const panel = queuePanel();
    expect(panel.getByText('a.wav')).toBeDefined();
    expect(panel.getByText('c.wav')).toBeDefined();

    // Files leave the queue as slots free, so all three eventually upload.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    act(() => {
      for (const source of FakeEventSource.instances) source.emit('status', JSON.stringify({ type: 'status', data: { status: 'COMPLETED' } }));
    });
    await waitFor(() => expect(transcribeCalls()).toHaveLength(3));
  });
});

describe('BatchTab queue concurrency', () => {
  it('holds a slot for the whole lifecycle, so three files never open three streams', async () => {
    gateUploads();
    renderTab('p-default');
    await enqueue('a.wav', 'b.wav', 'c.wav');

    // Two uploads in flight; the third waits for a free slot.
    await waitFor(() => expect(transcribeCalls()).toHaveLength(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(transcribeCalls()).toHaveLength(2);

    // Uploads land: the slots stay held by the RESULT STREAMS, so still no third.
    await act(async () => {
      releaseUploads();
      await Promise.resolve();
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(transcribeCalls()).toHaveLength(2);
  });

  it('starts the waiting file once a slot frees', async () => {
    renderTab('p-default');
    await enqueue('a.wav', 'b.wav', 'c.wav');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(transcribeCalls()).toHaveLength(2);

    act(() => FakeEventSource.instances[0].emit('status', JSON.stringify({ type: 'status', data: { status: 'COMPLETED' } })));

    await waitFor(() => expect(transcribeCalls()).toHaveLength(3));
  });
});

describe('BatchTab per-item actions', () => {
  it('cancels an in-flight upload and re-runs it on retry', async () => {
    gateUploads();
    renderTab('p-default');
    await enqueue('a.wav');
    await waitFor(() => expect(transcribeCalls()).toHaveLength(1));

    fireEvent.click(queuePanel().getByRole('button', { name: /cancel a\.wav/i }));
    await waitFor(() => expect(queuePanel().getByText('Cancelled')).toBeDefined());

    releaseUploads();
    uploadGate = null;
    fireEvent.click(queuePanel().getByRole('button', { name: /retry a\.wav/i }));
    await waitFor(() => expect(transcribeCalls()).toHaveLength(2));
  });

  it('removes one row and clears the whole queue', async () => {
    renderTab('p-default');
    await enqueue('a.wav', 'b.wav');

    fireEvent.click(queuePanel().getByRole('button', { name: /remove a\.wav from the queue/i }));
    await waitFor(() => expect(queuePanel().getAllByRole('listitem')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /clear queue/i }));
    await waitFor(() => expect(queuePanel().queryAllByRole('listitem')).toHaveLength(0));
  });
});

describe('BatchTab master/detail transcript', () => {
  it('shows an empty state until something is selected', () => {
    renderTab('p-default');
    expect(resultPanel().getByText(/nothing selected/i)).toBeDefined();
  });

  it('auto-selects the first file of a drop and switches on row click', async () => {
    renderTab('p-default');
    await enqueue('a.wav', 'b.wav');

    await waitFor(() => expect(resultPanel().getByText('a.wav')).toBeDefined());

    fireEvent.click(queuePanel().getByRole('button', { name: 'b.wav' }));
    await waitFor(() => expect(resultPanel().getByText('b.wav')).toBeDefined());
  });

  it('streams segments, then swaps in the job’s authoritative result text', async () => {
    renderTab('p-default');
    await enqueue('a.wav');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const source = FakeEventSource.instances[0];
    expect(source.url).toContain('/api/v1/audio/transcription-jobs/j-1/stream?ticket=');
    act(() => source.emit('chunk', JSON.stringify({ type: 'chunk', data: { text: 'headache since monday', isFinal: true, startTime: 0 } })));
    expect(await resultPanel().findByText(/headache since monday/i)).toBeDefined();

    act(() => source.emit('status', JSON.stringify({ type: 'status', data: { status: 'COMPLETED' } })));
    expect(await resultPanel().findByText('Authoritative transcript for j-1.')).toBeDefined();
  });

  it('mints one ticket scoped to the job the row is streaming', async () => {
    renderTab('p-default');
    await enqueue('a.wav');

    await waitFor(() => {
      const mint = calls.find((call) => call.path === '/api/auth/stream-ticket');
      expect(mint?.body).toEqual({ scope: 'transcription_job:j-1' });
    });
  });

  it('has no axe violations with a populated queue', async () => {
    listRows = [job({ id: 'j-old', status: 'COMPLETED' })];
    const { container } = renderTab('p-default');
    await enqueue('a.wav', 'b.wav');
    await screen.findByText('j-old');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('opens a past job from the recent-jobs table in the same panel', async () => {
    listRows = [job({ id: 'j-old', status: 'COMPLETED' })];
    renderTab('p-default');

    const strip = within(await screen.findByRole('region', { name: /my jobs/i }));
    fireEvent.click(await strip.findByRole('button', { name: /open transcript for job j-old/i }));

    expect(await resultPanel().findByText('Authoritative transcript for j-old.')).toBeDefined();
  });
});
