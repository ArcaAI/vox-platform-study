/**
 * lane B — `@arcaai/vox-node`'s workflow invocation surface.
 *
 * Every assertion here is pinned to an artifact the GATEWAY actually ships,
 * never to a shape invented for the SDK:
 *
 * | Asserted | Source of truth |
 * |---|---|
 * | route paths, methods | `apps/api/route-manifest.json` |
 * | reserved run-identity keys | `packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts` |
 * | SSE frame shape + resume-token placement | `apps/api/src/modules/workflows/workflow-run-event.ts` |
 * | event `type` literals | `apps/harness/src/harness/temporal/interpreter/run_events.py` |
 *
 * `route-manifest.json` is read from disk in `contract-conformance.task850.test.ts`
 * so the paths below cannot drift from the shipped manifest silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { HopeClient } from '../../client';
import { GatewayTimeoutError, HopeAPIError, NotFoundError, PermissionError, ReservedRunIdentityError } from '../../core/errors';
import { RESERVED_RUN_IDENTITY_KEYS } from '../../core/run-identity';

/** Build a `fetch` double that answers each call from `responses`, recording every request. */
function stubFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error(`stubFetch: no response configured for call ${index}`);
    return next();
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** An SSE response whose body is exactly `frames` (already wire-formatted). */
function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One wire frame in exactly the shape `formatSseFrame` emits. */
function frame(type: string, payload: Record<string, unknown>, resumeToken?: string): string {
  const envelope = {
    schemaVersion: 1,
    id: '01924f00-0000-7000-8000-000000000001',
    tenantId: '50000000-0000-0000-0000-000000000001',
    type,
    occurredAt: '2026-09-02T00:00:00.000Z',
    correlationId: String(payload.runId ?? 'run-1'),
    causationId: null,
    idempotencyKey: `wf:run:${String(payload.runId ?? 'run-1')}:x`,
    payload,
  };
  const idLine = resumeToken === undefined ? '' : `id: ${resumeToken}\n`;
  return `event: ${type}\n${idLine}data: ${JSON.stringify(envelope)}\n\n`;
}

const HANDLE = {
  runId: 'run-1',
  status: 'started' as const,
  statusUrl: '/api/v1/workflows/visit-summary/runs/run-1',
  streamUrl: '/api/v1/workflows/visit-summary/runs/run-1/stream',
};

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): HopeClient {
  return new HopeClient({ baseUrl: 'http://localhost:8868', apiKey: 'k-test', fetch: fetchImpl, maxRetries: 0, ...extra });
}

describe('WorkflowsResource — the unbound invocation plane', () => {
  it('lists published workflows from GET /api/v1/workflows', async () => {
    const summary = { slug: 'visit-summary', name: 'Visit Summary', description: null, paletteKey: 'summarization', versionNumber: 3 };
    const { fetch, calls } = stubFetch([() => json({ data: [summary] })]);

    const workflows = await client(fetch).workflows.list();

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(workflows).toEqual([summary]);
  });

  it('starts a run at POST /api/v1/workflows/{slug}/runs and returns the 202 handle', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    const handle = await client(fetch).workflows.run('visit-summary', { input: { note: 'hello' } });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: { note: 'hello' } });
    expect(handle).toEqual(HANDLE);
  });

  it('sends the caller Idempotency-Key as a HEADER, and surfaces already_running', async () => {
    const { fetch, calls } = stubFetch([() => json({ ...HANDLE, status: 'already_running' }, 202)]);

    const handle = await client(fetch).workflows.run('visit-summary', { input: {} }, { idempotencyKey: 'retry-key-1' });

    expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBe('retry-key-1');
    expect(handle.status).toBe('already_running');
  });

  it('mints an Idempotency-Key when asked, so a retry cannot double-bill by accident', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    await client(fetch).workflows.run('visit-summary', { input: {} }, { idempotent: true });

    const key = new Headers(calls[0]!.init.headers).get('Idempotency-Key');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('runAndWait sends ?mode=blocking and returns the terminal status', async () => {
    const terminal = { runId: 'run-1', slug: 'visit-summary', workflowVersionNumber: 3, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null, resultRef: { outputs: { text: 'ok' } } };
    const { fetch, calls } = stubFetch([() => json(terminal, 200)]);

    const result = await client(fetch).workflows.runAndWait('visit-summary', { input: {} });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs?mode=blocking');
    expect(result.status).toBe('COMPLETED');
  });

  it('runAndWait maps the 504 blocking ceiling to GatewayTimeoutError, not a generic failure', async () => {
    const { fetch } = stubFetch([() => json({ message: "Run 'run-1' did not finish within 60s." }, 504)]);

    const error = await client(fetch).workflows.runAndWait('visit-summary', { input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayTimeoutError);
    expect((error as GatewayTimeoutError).status).toBe(504);
    // The run is ALIVE — a developer must not read this as a failed run.
    expect((error as GatewayTimeoutError).message).toMatch(/still executing|did not finish/i);
  });

  it('reads a run status and cancels a run on the shipped paths', async () => {
    const status = { runId: 'run-1', slug: 'visit-summary', workflowVersionNumber: 3, status: 'RUNNING', stages: [], startedAt: null, endedAt: null, resultRef: null };
    const { fetch, calls } = stubFetch([() => json(status), () => json({ runId: 'run-1', status: 'cancel_requested' })]);
    const hope = client(fetch);

    await hope.workflows.getRun('visit-summary', 'run-1');
    await hope.workflows.cancelRun('visit-summary', 'run-1');

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs/run-1');
    expect(calls[1]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs/run-1/cancel');
    expect(calls[1]!.init.method).toBe('POST');
  });
});

describe('Reserved run-identity keys are refused BEFORE the request leaves the SDK', () => {
  it.each(RESERVED_RUN_IDENTITY_KEYS)('refuses `%s` in input without issuing a request', async (key) => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    const error = await client(fetch)
      .workflows.run('visit-summary', { input: { [key]: 'x' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReservedRunIdentityError);
    expect((error as ReservedRunIdentityError).keys).toEqual([key]);
    // THE point of the early refusal: nothing was sent.
    expect(calls).toHaveLength(0);
  });

  it('names every offending key at once rather than one per round trip', async () => {
    const { fetch } = stubFetch([() => json(HANDLE, 202)]);

    const error = await client(fetch)
      .workflows.run('s', { input: { consultationId: 'c', userId: 'u', note: 'kept' } })
      .catch((e: unknown) => e);

    expect((error as ReservedRunIdentityError).keys).toEqual(['consultationId', 'userId']);
    expect((error as Error).message).toContain('consultationId');
    expect((error as Error).message).toContain('userId');
  });

  it('refuses them on the consultation-bound plane too — where the id comes from the URL', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    const error = await client(fetch)
      .consultations.workflows.run('con-1', 'note-writer', { input: { consultationId: 'other' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReservedRunIdentityError);
    expect(calls).toHaveLength(0);
  });

  it('mirrors the gateway list byte-for-byte', () => {
    // `exposure-palette-policy.ts#RESERVED_RUN_IDENTITY_KEYS`, in order.
    expect(RESERVED_RUN_IDENTITY_KEYS).toEqual(['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId']);
  });
});

describe('ConsultationWorkflowsResource — the consultation-bound plane', () => {
  it('lists on GET /api/v1/consultations/{id}/workflows', async () => {
    const { fetch, calls } = stubFetch([() => json({ data: [] })]);

    await client(fetch).consultations.workflows.list('con-1');

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/consultations/con-1/workflows');
  });

  it('runs on POST /api/v1/consultations/{id}/workflows/{slug}/runs, id in the URL and never the body', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    await client(fetch).consultations.workflows.run('con-1', 'note-writer', { input: { tone: 'brief' } }, { idempotencyKey: 'k' });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/consultations/con-1/workflows/note-writer/runs');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: { tone: 'brief' } });
    expect(new Headers(calls[0]!.init.headers).get('Idempotency-Key')).toBe('k');
  });

  it('percent-encodes path segments so a slug can never escape its position', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);

    await client(fetch).consultations.workflows.run('con/1', 'a b', { input: {} });

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/consultations/con%2F1/workflows/a%20b/runs');
  });
});

describe('Streaming — snapshot-then-delta, with real resume', () => {
  const snapshot = frame('workflow.run.progress', { runId: 'run-1', slug: 'visit-summary', status: 'RUNNING', stages: [], startedAt: null, endedAt: null, workflowVersionNumber: 3 });
  const nodeA = frame('workflow.node.started', { runId: 'run-1', nodeId: 'n1' }, '1699999999-0');
  const nodeB = frame('workflow.node.completed', { runId: 'run-1', nodeId: 'n1' }, '1699999999-1');
  const done = frame('workflow.run.completed', { runId: 'run-1', slug: 'visit-summary', status: 'COMPLETED', stages: [], startedAt: null, endedAt: null, workflowVersionNumber: 3 }, '1699999999-2');

  it('yields every frame and exposes the snapshot as having NO resume token', async () => {
    const { fetch, calls } = stubFetch([() => sse([snapshot, nodeA, done])]);

    const seen = [];
    for await (const event of client(fetch).workflows.streamRun('visit-summary', 'run-1')) seen.push(event);

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs/run-1/stream');
    expect(new Headers(calls[0]!.init.headers).get('Accept')).toBe('text/event-stream');
    expect(seen.map((e) => e.type)).toEqual(['workflow.run.progress', 'workflow.node.started', 'workflow.run.completed']);
    expect(seen[0]!.resumeToken).toBeUndefined();
    expect(seen[1]!.resumeToken).toBe('1699999999-0');
  });

  it('RESUMES after a mid-stream disconnect and loses nothing', async () => {
    // Connection 1 drops after `nodeA` — no terminal frame.
    // Connection 2 must be sent `Last-Event-ID: 1699999999-0` and delivers the rest.
    const { fetch, calls } = stubFetch([() => sse([snapshot, nodeA]), () => sse([nodeB, done])]);

    const seen = [];
    for await (const event of client(fetch).workflows.streamRun('visit-summary', 'run-1')) seen.push(event);

    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('Last-Event-ID')).toBeNull();
    expect(new Headers(calls[1]!.init.headers).get('Last-Event-ID')).toBe('1699999999-0');
    expect(seen.map((e) => e.type)).toEqual([
      'workflow.run.progress',
      'workflow.node.started',
      'workflow.node.completed',
      'workflow.run.completed',
    ]);
  });

  it('stops resuming once the run is terminal — a completed run is not reconnected to', async () => {
    const { fetch, calls } = stubFetch([() => sse([snapshot, done]), () => sse([])]);

    const seen = [];
    for await (const event of client(fetch).workflows.streamRun('visit-summary', 'run-1')) seen.push(event);

    expect(calls).toHaveLength(1);
    expect(seen.at(-1)!.type).toBe('workflow.run.completed');
  });

  it('honors an explicit starting cursor', async () => {
    const { fetch, calls } = stubFetch([() => sse([done])]);

    for await (const _ of client(fetch).workflows.streamRun('visit-summary', 'run-1', { lastEventId: 'cursor-9' })) void _;

    expect(new Headers(calls[0]!.init.headers).get('Last-Event-ID')).toBe('cursor-9');
  });

  it('gives up after maxResumeAttempts rather than reconnecting forever', async () => {
    const { fetch, calls } = stubFetch([() => sse([snapshot, nodeA]), () => sse([]), () => sse([])]);

    const seen = [];
    for await (const event of client(fetch).workflows.streamRun('visit-summary', 'run-1', { maxResumeAttempts: 1 })) seen.push(event);

    expect(calls).toHaveLength(2);
    expect(seen.map((e) => e.type)).toEqual(['workflow.run.progress', 'workflow.node.started']);
  });

  it('runAndStream starts with ?mode=stream and resumes on the RUN id, never by re-posting', async () => {
    const { fetch, calls } = stubFetch([() => sse([snapshot, nodeA]), () => sse([nodeB, done])]);

    const seen = [];
    for await (const event of client(fetch).workflows.runAndStream('visit-summary', { input: {} })) seen.push(event);

    expect(calls[0]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs?mode=stream');
    expect(calls[0]!.init.method).toBe('POST');
    // The resume is a GET on the run — re-POSTing would start a SECOND run.
    expect(calls[1]!.url).toBe('http://localhost:8868/api/v1/workflows/visit-summary/runs/run-1/stream');
    expect(calls[1]!.init.method ?? 'GET').toBe('GET');
    expect(seen).toHaveLength(4);
  });

  it('waitFor resolves with the terminal snapshot the stream delivers', async () => {
    const { fetch } = stubFetch([() => sse([snapshot, done])]);

    const status = await client(fetch).workflows.waitForRun('visit-summary', 'run-1');

    expect(status.status).toBe('COMPLETED');
    expect(status.runId).toBe('run-1');
  });
});

describe('Error surfaces a developer actually sees', () => {
  it('400 → HopeAPIError carrying the gateway message about the reserved field', async () => {
    const { fetch } = stubFetch([() => json({ message: "Reserved run-identity field 'consultationId' is not accepted." }, 400)]);

    const error = await client(fetch).workflows.getRun('s', 'r').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HopeAPIError);
    expect((error as HopeAPIError).status).toBe(400);
    expect((error as Error).message).toContain('consultationId');
  });

  it('403 → PermissionError (scope/ability), distinct from 404', async () => {
    const { fetch } = stubFetch([() => json({ message: 'Forbidden' }, 403)]);
    const error = await client(fetch).workflows.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionError);
  });

  it('404 → NotFoundError whose message states the 404-over-403 tenancy posture', async () => {
    const { fetch } = stubFetch([() => json({ message: 'Not Found' }, 404)]);
    const error = await client(fetch).workflows.getRun('s', 'r').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toMatch(/different tenant/i);
  });
});

describe('The workflow plane is API-key-only — a service-account client is refused early', () => {
  it('throws a plane-specific error instead of letting the gateway answer a confusing 403', async () => {
    const { fetch, calls } = stubFetch([() => json(HANDLE, 202)]);
    const hope = new HopeClient({
      baseUrl: 'http://localhost:8868',
      serviceAccount: { clientId: 'svc', clientSecret: 's3cret' },
      fetch,
      maxRetries: 0,
    });

    const error = await hope.workflows.run('visit-summary', { input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/service account/i);
    expect((error as Error).message).toMatch(/api key/i);
    // Not even the token exchange should have been attempted.
    expect(calls).toHaveLength(0);
  });

  it('applies to the consultation-bound plane and to streaming as well', async () => {
    const { fetch } = stubFetch([() => json(HANDLE, 202)]);
    const hope = new HopeClient({ baseUrl: 'http://localhost:8868', serviceAccount: { clientId: 'a', clientSecret: 'b' }, fetch, maxRetries: 0 });

    await expect(hope.consultations.workflows.list('con-1')).rejects.toThrow(/service account/i);
    await expect(
      (async () => {
        for await (const _ of hope.workflows.streamRun('s', 'r')) void _;
      })(),
    ).rejects.toThrow(/service account/i);
  });
});
