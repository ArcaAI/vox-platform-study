/**
 * TASK-932 wave 4 lane L — the shared SSE relay's late-join contract.
 *
 * This helper is the ONE relay every live consumer of a consultation reaches through, the
 * published `@arcaai/vox` 3.1.0 included, so its contract is widened additively and pinned here
 * rather than only at a call site.
 *
 * **L-1 — a late joiner may be owed MORE THAN ONE cached entry.** `loadSnapshot` widens from
 * `string` to `string | string[]`: the live-summary lane hands back the whole-document snapshot
 * AND the last `presummary` event, in that order, because they are cached under different keys
 * and a warm start published before the console subscribed is otherwise lost forever (measured
 * live: `degraded` at +29 ms, subscribe at +56 ms). A single-string caller — `harness-progress`,
 * `harness-assurance`, `harness-live-assist` — must behave EXACTLY as it did before, which is
 * what the third test asserts.
 *
 * **L-2 — the frame TYPE is tagged from the payload's own `event` field**, opt-in per caller.
 * `section.patch` / `presummary` become named SSE frames; the undiscriminated whole-document
 * snapshot and the terminal `closed: true` stay on the default `message` type. Nest's `SseStream`
 * writes `event: <type>` for a `MessageEvent.type`, so a named frame reaches
 * `EventSource.addEventListener('section.patch', …)` and NOT `onmessage` — which is exactly what
 * SDK 3.1.0's hook already does with these payloads (it folds a default `message` with no string
 * `event` as a snapshot and returns early on everything else). The JSON payload is byte-identical
 * either way, and a caller that does not opt in relays exactly as it does today.
 */
import { Logger, type MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { sseFromRedisChannel, type RedisChannelSseOptions } from '../redis-channel-sse';

const CHANNEL = 'consultation:live-summary:c-1';
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A refcount-free stand-in for `RedisSubscriberService` — enough to relay and to tear down. */
function makeSubscriber() {
  const subject = new Subject<string>();
  return {
    subscribeToChannel: vi.fn(async (): Promise<Observable<string>> => subject.asObservable()),
    publish: (message: string) => subject.next(message),
  };
}

function subscribe(options: Partial<RedisChannelSseOptions> = {}) {
  const subscriber = makeSubscriber();
  const events: MessageEvent[] = [];
  const stream = sseFromRedisChannel(subscriber, new Logger('test'), {
    channel: CHANNEL,
    // Long enough that no heartbeat can interleave with the assertions.
    heartbeatMs: 60_000,
    setupErrorPayload: JSON.stringify({ error: 'setup failed' }),
    logContext: {},
    ...options,
  });
  const sub = stream.subscribe((event) => events.push(event));
  return { subscriber, events, sub };
}

const SNAPSHOT = JSON.stringify({ consultationId: 'c-1', runningSummary: 'note', sections: [], entities: [], updatedAt: '2026-09-09T00:00:00.000Z' });
const PRESUMMARY = JSON.stringify({
  event: 'presummary',
  consultationId: 'c-1',
  status: 'degraded',
  error: 'no_case_notes',
  updatedAt: '2026-09-09T00:00:01.000Z',
});
const PATCH = JSON.stringify({ event: 'section.patch', consultationId: 'c-1', sectionKey: 's', revision: 1, updatedAt: '2026-09-09T00:00:02.000Z' });

describe('L-1 — `loadSnapshot` may answer with several entries', () => {
  it('emits every entry of a `string[]` snapshot, in the order given, BEFORE the relay', async () => {
    const { subscriber, events, sub } = subscribe({ loadSnapshot: async () => [SNAPSHOT, PRESUMMARY] });
    await tick();

    subscriber.publish(PATCH);
    await tick();

    expect(events.map((event) => event.data)).toEqual([SNAPSHOT, PRESUMMARY, PATCH]);
    sub.unsubscribe();
  });

  it('drops empty entries rather than emitting a blank frame', async () => {
    const { events, sub } = subscribe({ loadSnapshot: async () => ['', SNAPSHOT] });
    await tick();

    expect(events.map((event) => event.data)).toEqual([SNAPSHOT]);
    sub.unsubscribe();
  });

  it('a SINGLE string behaves exactly as today — one frame, then the relay', async () => {
    const { subscriber, events, sub } = subscribe({ loadSnapshot: async () => SNAPSHOT });
    await tick();

    subscriber.publish(PATCH);
    await tick();

    expect(events.map((event) => event.data)).toEqual([SNAPSHOT, PATCH]);
    sub.unsubscribe();
  });

  it('hands the predicate the FIRST entry as `snapshot` and EVERY entry as `emitted`', async () => {
    const seen: Array<[string, string | null | undefined, readonly string[]]> = [];
    const { subscriber, sub } = subscribe({
      loadSnapshot: async () => [SNAPSHOT, PRESUMMARY],
      isDuplicateOfSnapshot: (raw, snapshot, emitted) => {
        seen.push([raw, snapshot, emitted]);
        return false;
      },
    });
    await tick();

    subscriber.publish(PATCH);
    await tick();

    expect(seen).toEqual([[PATCH, SNAPSHOT, [SNAPSHOT, PRESUMMARY]]]);
    sub.unsubscribe();
  });
});

describe('L-2 — the frame type is tagged from the payload`s own `event`', () => {
  it('tags a discriminated payload with its `event` value, leaving the JSON byte-identical', async () => {
    const { subscriber, events, sub } = subscribe({ tagFrameTypeFromPayload: true });
    await tick();

    subscriber.publish(PATCH);
    subscriber.publish(PRESUMMARY);
    await tick();

    expect(events.map((event) => [event.type, event.data])).toEqual([
      ['section.patch', PATCH],
      ['presummary', PRESUMMARY],
    ]);
    sub.unsubscribe();
  });

  it('leaves an UNDISCRIMINATED payload on the default `message` type — the snapshot and `closed` still reach `onmessage`', async () => {
    const closed = JSON.stringify({ consultationId: 'c-1', closed: true, updatedAt: '2026-09-09T00:00:03.000Z' });
    const { subscriber, events, sub } = subscribe({ tagFrameTypeFromPayload: true, loadSnapshot: async () => SNAPSHOT });
    await tick();

    subscriber.publish(closed);
    await tick();

    expect(events.map((event) => event.type)).toEqual([undefined, undefined]);
    expect(events.map((event) => event.data)).toEqual([SNAPSHOT, closed]);
    sub.unsubscribe();
  });

  it('tags a REPLAYED cached entry too — a late joiner`s pre-summary must arrive on the same named frame as a live one', async () => {
    const { events, sub } = subscribe({ tagFrameTypeFromPayload: true, loadSnapshot: async () => [SNAPSHOT, PRESUMMARY] });
    await tick();

    expect(events.map((event) => [event.type, event.data])).toEqual([
      [undefined, SNAPSHOT],
      ['presummary', PRESUMMARY],
    ]);
    sub.unsubscribe();
  });

  it('never tags a non-JSON or empty-`event` message', async () => {
    const { subscriber, events, sub } = subscribe({ tagFrameTypeFromPayload: true });
    await tick();

    subscriber.publish('not json at all');
    subscriber.publish(JSON.stringify({ event: '', consultationId: 'c-1' }));
    subscriber.publish(JSON.stringify({ event: 42, consultationId: 'c-1' }));
    await tick();

    expect(events.map((event) => event.type)).toEqual([undefined, undefined, undefined]);
    sub.unsubscribe();
  });

  it('does NOT tag when the caller did not opt in — the three harness relays are untouched by construction', async () => {
    const { subscriber, events, sub } = subscribe();
    await tick();

    subscriber.publish(PATCH);
    await tick();

    expect(events.map((event) => [event.type, event.data])).toEqual([[undefined, PATCH]]);
    sub.unsubscribe();
  });
});
