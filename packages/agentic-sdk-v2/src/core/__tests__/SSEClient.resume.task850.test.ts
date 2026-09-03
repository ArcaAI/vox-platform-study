/**
 * lane B — `SSEClient` must be able to RESUME.
 *
 * ## The gap this closes
 *
 * `EventSource` tracks `lastEventId` itself and replays it on ITS OWN internal
 * reconnect. But `SSEClient` does not use that reconnect: every reconnect here
 * CLOSES the `EventSource` and constructs a new one, because each connect must
 * mint a fresh single-use stream ticket. A brand-new `EventSource` has an empty
 * `lastEventId`, so the browser's resume is discarded on exactly the path this
 * client actually takes.
 *
 * For a job stream that only reports status, losing the gap is survivable — the
 * next status frame is the whole truth. For a WORKFLOW RUN stream it is not:
 * the frames between the two connections are the run's node/token events, and
 * nothing re-sends them. The gateway exposes `?lastEventId=` for precisely this
 * client (`workflows.controller.ts`: "the manual escape hatch for a client that
 * cannot set headers").
 *
 * ## Why opt-in
 *
 * `resume: true` is off by default. Appending an unrecognized query parameter to
 * every existing SSE consumer's URL is a change to routes this ticket has no
 * business touching; the workflow-run stream asks for it explicitly.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SSEClient } from '../SSEClient';
import { createMockLogger } from '../../__tests__/setup';

async function flushPromises(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

type MockEventSourceListener = (event: MessageEvent) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState: number = MockEventSource.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners: Record<string, MockEventSourceListener[]> = {};

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: MockEventSourceListener): void {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type: string, listener: MockEventSourceListener): void {
    if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }
  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }
  simulateError(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
  /** Dispatch a named frame carrying an SSE `id:` — the opaque resume token. */
  simulateNamed(type: string, data: string, lastEventId?: string): void {
    const event = new MessageEvent(type, { data, lastEventId });
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

const originalEventSource = globalThis.EventSource;
let created: MockEventSource[] = [];

beforeEach(() => {
  created = [];
  (globalThis as any).EventSource = class extends MockEventSource {
    constructor(url: string) {
      super(url);
      created.push(this);
    }
  };
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  created = [];
  vi.useRealTimers();
});

function makeApiClient() {
  let n = 0;
  return {
    post: vi.fn(async () => {
      n += 1;
      return { ticket: `TKT-${n}` };
    }),
    getBaseUrl: () => 'https://api.example.com',
  };
}

const URL_UNDER_TEST = 'https://api.example.com/api/v1/workflows/visit-summary/runs/run-1/stream';

describe('SSEClient resume (opt-in)', () => {
  it('sends NO lastEventId on a first connect — there is no cursor to name yet', async () => {
    const client = new SSEClient('workflow_run:run-1', makeApiClient() as never, createMockLogger());
    client.connect(URL_UNDER_TEST, { resume: true });
    await flushPromises();

    expect(created).toHaveLength(1);
    expect(created[0]!.url).toContain('ticket=TKT-1');
    expect(created[0]!.url).not.toContain('lastEventId');
  });

  it('replays the last seen event id on RECONNECT, so no frames are lost in the gap', async () => {
    vi.useFakeTimers();
    const client = new SSEClient('workflow_run:run-1', makeApiClient() as never, createMockLogger());
    client.onEvent('workflow.node.started', () => {});
    client.connect(URL_UNDER_TEST, { resume: true, autoReconnect: true, reconnectIntervalMs: 10 });
    await flushPromises();

    created[0]!.simulateOpen();
    created[0]!.simulateNamed('workflow.node.started', '{"x":1}', '1699999999-3');
    created[0]!.simulateError();

    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();

    expect(created.length).toBeGreaterThanOrEqual(2);
    const reconnectUrl = created[created.length - 1]!.url;
    expect(reconnectUrl).toContain(`lastEventId=${encodeURIComponent('1699999999-3')}`);
    // A FRESH ticket each connect — resume must not weaken the single-use rule.
    expect(reconnectUrl).toContain('ticket=TKT-2');
  });

  it('does not append lastEventId when resume is not requested — existing consumers are untouched', async () => {
    vi.useFakeTimers();
    const client = new SSEClient('consultation-jobs', makeApiClient() as never, createMockLogger());
    client.onEvent('status', () => {});
    client.connect(URL_UNDER_TEST, { autoReconnect: true, reconnectIntervalMs: 10 });
    await flushPromises();

    created[0]!.simulateOpen();
    created[0]!.simulateNamed('status', '{"status":"RUNNING"}', 'cursor-1');
    created[0]!.simulateError();

    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();

    expect(created[created.length - 1]!.url).not.toContain('lastEventId');
  });

  it('exposes the cursor so a caller can persist it across a page reload', async () => {
    const client = new SSEClient('workflow_run:run-1', makeApiClient() as never, createMockLogger());
    client.onEvent('workflow.node.completed', () => {});
    client.connect(URL_UNDER_TEST, { resume: true });
    await flushPromises();

    expect(client.getLastEventId()).toBeNull();
    created[0]!.simulateNamed('workflow.node.completed', '{}', 'cursor-7');
    expect(client.getLastEventId()).toBe('cursor-7');
  });

  it('accepts a starting cursor, so a reload resumes where the previous page left off', async () => {
    const client = new SSEClient('workflow_run:run-1', makeApiClient() as never, createMockLogger());
    client.connect(URL_UNDER_TEST, { resume: true, lastEventId: 'from-storage-9' });
    await flushPromises();

    expect(created[0]!.url).toContain(`lastEventId=${encodeURIComponent('from-storage-9')}`);
  });

  it('never advances the cursor on a frame that carried no id — the snapshot frame has none', async () => {
    const client = new SSEClient('workflow_run:run-1', makeApiClient() as never, createMockLogger());
    client.onEvent('workflow.run.progress', () => {});
    client.onEvent('workflow.node.started', () => {});
    client.connect(URL_UNDER_TEST, { resume: true });
    await flushPromises();

    created[0]!.simulateNamed('workflow.node.started', '{}', 'real-cursor');
    // The gateway's snapshot frame deliberately carries no `id:`. Letting it
    // blank the cursor would re-deliver the whole retained window on reconnect.
    created[0]!.simulateNamed('workflow.run.progress', '{}', '');
    expect(client.getLastEventId()).toBe('real-cursor');
  });
});
