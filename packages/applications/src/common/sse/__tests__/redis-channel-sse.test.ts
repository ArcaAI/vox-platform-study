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
