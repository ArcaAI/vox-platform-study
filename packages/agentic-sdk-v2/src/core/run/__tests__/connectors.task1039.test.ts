/**
 * @vitest-environment jsdom
 *
 * TASK-1039 — the two ways a browser opens a run stream: `EventSource` with a fresh run-scoped
 * ticket per connect, and a header-authenticated `fetch` stream.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventSourceConnector, createFetchConnector, followRun, RunStreamHttpError } from '../RunStreamClient';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (event: Event) => void>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data: unknown, lastEventId = ''): void {
    const event = Object.assign(new Event(name), { data: JSON.stringify(data), lastEventId });
    this.listeners.get(name)?.(event);
  }
}

const envelope = (type: string, seq: number, data: Record<string, unknown>) => ({ seq, runId: 'run-1', type, ts: '2026-10-04T10:00:00.000Z', data });

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('createEventSourceConnector', () => {
  it('mints a URL (and so a ticket) for EVERY connect, with the cursor the engine asked for', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const buildUrl = vi.fn(async ({ after }: { after: number | undefined }) => `https://api.example.com/stream?ticket=t${FakeEventSource.instances.length}${after ? `&after=${after}` : ''}`);
    const events: string[] = [];

    const done = followRun({
      runId: 'run-1',
      connector: createEventSourceConnector(buildUrl),
      onEvent: (event) => events.push(event.type),
      reconnectDelayMs: 0,
    });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.emit('output.text.delta', envelope('output.text.delta', 4, { field: 'text', text: 'a' }), '4');
    first.onerror?.(); // the connection drops

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe('https://api.example.com/stream?ticket=t1&after=4');
    expect(first.closed).toBe(true);
    second.onopen?.();
    second.emit('run.completed', envelope('run.completed', 5, { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }), '5');

    expect(await done).toBe('terminal');
    expect(events).toEqual(['output.text.delta', 'run.completed']);
    expect(buildUrl).toHaveBeenCalledTimes(2);
    expect(second.closed).toBe(true);
  });

  it('subscribes by name to the v2 types and the legacy workflow frames', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const controller = new AbortController();
    const running = createEventSourceConnector(async () => 'https://api.example.com/stream')({
      after: undefined,
      legacyId: undefined,
      signal: controller.signal,
      onFrame: () => undefined,
    });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const names = [...FakeEventSource.instances[0]!.listeners.keys()];
    expect(names).toEqual(expect.arrayContaining(['output.text.delta', 'run.resync', 'ping', 'workflow.token.delta', 'workflow.run.completed']));
    controller.abort();
    await running;
  });

  it('treats a stream that never opened as a transient failure counted against the budget', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const connect = createEventSourceConnector(async () => 'https://api.example.com/stream');
    const attempt = connect({ after: undefined, legacyId: undefined, signal: new AbortController().signal, onFrame: () => undefined });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0]!.onerror?.();

    await expect(attempt).rejects.toBeInstanceOf(RunStreamHttpError);
  });

  it('closes the EventSource when the signal aborts, without an error', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const controller = new AbortController();
    const attempt = createEventSourceConnector(async () => 'https://api.example.com/stream')({
      after: undefined,
      legacyId: undefined,
      signal: controller.signal,
      onFrame: () => undefined,
    });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    controller.abort();
    await expect(attempt).resolves.toBeUndefined();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('createFetchConnector', () => {
  const frame = (type: string, seq: number, data: Record<string, unknown>) => `event: ${type}\nid: ${seq}\ndata: ${JSON.stringify(envelope(type, seq, data))}\n\n`;

  it('selects protocol v2 by header, carries the cursor as Last-Event-ID, and parses the frames', async () => {
    const open = vi.fn(async (_request: { headers: Record<string, string>; signal: AbortSignal }) => new Response(sseBody(frame('run.completed', 9, { status: 'COMPLETED', durationMs: 1, tokens: { in: 0, out: 0 } }))));
    const events: string[] = [];

    const outcome = await followRun({
      runId: 'run-1',
      connector: createFetchConnector(open),
      onEvent: (event) => events.push(`${event.type}#${event.seq}`),
      after: 8,
      reconnectDelayMs: 0,
    });

    expect(outcome).toBe('terminal');
    expect(events).toEqual(['run.completed#9']);
    expect(open.mock.calls[0]![0].headers).toMatchObject({ 'x-hope-run-protocol': '2', 'Last-Event-ID': '8', Accept: 'text/event-stream' });
  });

  it('sends no Last-Event-ID on a first connect', async () => {
    const open = vi.fn(async (_request: { headers: Record<string, string>; signal: AbortSignal }) => new Response(sseBody('')));
    await createFetchConnector(open)({ after: undefined, legacyId: undefined, signal: new AbortController().signal, onFrame: () => undefined });
    expect(open.mock.calls[0]![0].headers).not.toHaveProperty('Last-Event-ID');
  });

  it('lets a refusal from the opener propagate (a 404 is not retried by the engine)', async () => {
    const connector = createFetchConnector(async () => {
      throw new RunStreamHttpError(404);
    });
    await expect(followRun({ runId: 'run-1', connector, onEvent: () => undefined, reconnectDelayMs: 0 })).rejects.toMatchObject({ status: 404 });
  });
});
