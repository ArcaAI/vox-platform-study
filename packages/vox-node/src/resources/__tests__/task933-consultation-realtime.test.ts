/**
 * TASK-933 lane H2 — the consultation REALTIME lifecycle on the Node SDK:
 * `open`, the recording sub-resource, and the four SSE stream subscriptions.
 *
 * Hermetic: every gateway call goes through a `fetch` double. Nothing here
 * opens a socket or reaches a live gateway.
 */

import { describe, expect, it, vi } from 'vitest';

import { Transport } from '../../core/transport';
import { ConsultationsResource } from '../consultations';
import { JobsResource } from '../jobs';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An SSE response whose body streams `frames` and then ends. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function transportWith(fetchImpl: typeof fetch): Transport {
  return new Transport({ baseUrl: 'http://localhost:8868', fetch: fetchImpl });
}

const CONSULTATION = {
  id: 'c1',
  patientId: 'p1',
  doctorId: 'clinician-1',
  departmentId: 'dept-1',
  appointmentDate: '2026-09-09',
  status: 'OPEN' as const,
  isNew: true,
  createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z',
};

// -----------------------------------------------------------------------------
// open
// -----------------------------------------------------------------------------

describe('ConsultationsResource#open', () => {
  it('POSTs /api/v1/consultations/open with the request body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CONSULTATION));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const result = await resource.open({
      patientId: 'p1',
      departmentId: 'dept-1',
      clinicianUserId: 'clinician-1',
      language: 'en',
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/open');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      patientId: 'p1',
      departmentId: 'dept-1',
      clinicianUserId: 'clinician-1',
      language: 'en',
    });
    expect(result.doctorId).toBe('clinician-1');
    expect(result.isNew).toBe(true);
  });

  it('refuses an empty patientId locally, before any request is issued', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CONSULTATION));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    await expect(resource.open({ patientId: '  ' })).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// recording
// -----------------------------------------------------------------------------

const RECORDING_STATE = {
  consultationId: 'c1',
  status: 'RECORDING',
  recording: true,
  sessionId: 'sess-1',
  sseUrl: '/consultations/c1/live-summary/stream',
  updatedAt: '2026-09-09T00:00:01Z',
};

describe('ConsultationsResource#recording', () => {
  it('starts recording, binding the STT session id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, RECORDING_STATE));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const state = await resource.recording.start('c1', { sessionId: 'sess-1' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/recording/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'sess-1' });
    expect(state.recording).toBe(true);
  });

  it('stops recording with an empty body when the caller passes none', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ...RECORDING_STATE, recording: false, status: 'OPEN' }));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    await resource.recording.stop('c1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/recording/stop');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('forwards persistSnapshot and acceptedProposals on stop', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { ...RECORDING_STATE, recording: false }));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    await resource.recording.stop('c1', {
      persistSnapshot: true,
      acceptedProposals: [{ proposalId: 'x', start: 0, end: 4, original: 'nife', proposed: 'nifedipine', status: 'ACCEPTED' }],
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).persistSnapshot).toBe(true);
    expect(JSON.parse(String(init.body)).acceptedProposals).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// streams
// -----------------------------------------------------------------------------

/**
 * A `{ onClosed, onError }` pair plus the promise that settles when either
 * fires — a subscription is fire-and-forget, so a test that only drains
 * microtasks races the SSE pump.
 */
function completion(): { settled: Promise<'closed' | 'error'>; onClosed: () => void; onError: (error: unknown) => void; errors: unknown[] } {
  const errors: unknown[] = [];
  let resolve!: (value: 'closed' | 'error') => void;
  const settled = new Promise<'closed' | 'error'>((r) => {
    resolve = r;
  });
  return {
    settled,
    errors,
    onClosed: () => resolve('closed'),
    onError: (error: unknown) => {
      errors.push(error);
      resolve('error');
    },
  };
}

describe('ConsultationStreamsResource#liveSummary', () => {
  it('discriminates snapshot / section.patch / presummary payloads on one channel', async () => {
    const frames = [
      `data: ${JSON.stringify({ consultationId: 'c1', runningSummary: 'hello', sections: [], entities: [], updatedAt: 'now' })}\n\n`,
      `data: ${JSON.stringify({ event: 'section.patch', consultationId: 'c1', documentKey: 'soap_note', sectionKey: 's', title: 'S', idx: 0, revision: 2, state: 'provisional', content: 'x', updatedAt: 'now' })}\n\n`,
      `data: ${JSON.stringify({ event: 'presummary', consultationId: 'c1', status: 'ready', content: 'warm', updatedAt: 'now' })}\n\n`,
      `data: ${JSON.stringify({ consultationId: 'c1', runningSummary: 'final', sections: [], entities: [], closed: true, updatedAt: 'now' })}\n\n`,
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(frames));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const snapshots: unknown[] = [];
    const patches: unknown[] = [];
    const preSummaries: unknown[] = [];
    const done = completion();

    resource.streams.liveSummary('c1', {
      onSnapshot: (event) => snapshots.push(event),
      onSectionPatch: (event) => patches.push(event),
      onPreSummary: (event) => preSummaries.push(event),
      onClosed: done.onClosed,
      onError: done.onError,
    });

    expect(await done.settled).toBe('closed');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/consultations/c1/live-summary/stream');
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
    expect(snapshots).toHaveLength(2);
    expect(patches).toHaveLength(1);
    expect(preSummaries).toHaveLength(1);
  });

  it('reports a gateway refusal through onError instead of swallowing it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(403, { message: 'Forbidden' }));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const done = completion();
    resource.streams.liveSummary('c1', { onSnapshot: () => undefined, onError: done.onError });

    expect(await done.settled).toBe('error');
    expect(done.errors).toHaveLength(1);
  });

  it('close() stops the subscription', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse([]));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const done = completion();
    const handle = resource.streams.liveSummary('c1', { onSnapshot: () => undefined, onClosed: done.onClosed, onError: done.onError });
    expect(typeof handle.close).toBe('function');
    handle.close();
    expect(await done.settled).toBe('closed');
  });
});

describe('ConsultationStreamsResource — the sibling planes', () => {
  it.each([
    ['liveAssist', 'live-assist'],
    ['harnessProgress', 'harness-progress'],
    ['loop', 'loop'],
  ] as const)('%s subscribes to /:id/%s/stream', async (method, segment) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse([`data: ${JSON.stringify({ consultationId: 'c1' })}\n\n`]));
    const resource = new ConsultationsResource(transportWith(fetchImpl));

    const events: unknown[] = [];
    const done = completion();
    resource.streams[method]('c1', { onEvent: (event) => events.push(event), onClosed: done.onClosed, onError: done.onError });
    expect(await done.settled).toBe('closed');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`http://localhost:8868/api/v1/consultations/c1/${segment}/stream`);
    expect(events).toHaveLength(1);
  });
});

describe('JobsResource#subscribe', () => {
  it('delivers job frames to onEvent and closes on a terminal status', async () => {
    const frames = [
      `data: ${JSON.stringify({ jobId: 'j1', status: 'RUNNING', progress: 10 })}\n\n`,
      `data: ${JSON.stringify({ jobId: 'j1', status: 'COMPLETED', progress: 100 })}\n\n`,
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(frames));
    const jobs = new JobsResource(transportWith(fetchImpl));

    const seen: unknown[] = [];
    const done = completion();
    jobs.subscribe('j1', { onEvent: (event) => seen.push(event), onClosed: done.onClosed, onError: done.onError });

    expect(await done.settled).toBe('closed');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/jobs/j1/stream');
    expect(seen).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// credential class
// -----------------------------------------------------------------------------

describe('ConsultationWorkflowsResource credential class (TASK-933)', () => {
  it('no longer refuses a service-account client on the consultation-bound plane', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, []));
    const resource = new ConsultationsResource(transportWith(fetchImpl), true);

    await expect(resource.workflows.list('c1')).resolves.toEqual([]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:8868/api/v1/consultations/c1/workflows');
  });
});
