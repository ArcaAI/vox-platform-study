import { Logger, type MessageEvent } from '@nestjs/common';
import { Observable, ReplaySubject, Subject, type Subscription, filter, interval, map, merge, takeWhile } from 'rxjs';

/**
 * The slice of `RedisSubscriberService` an SSE relay needs. Structural on
 * purpose — `common/` must not depend on `services/`.
 */
export interface RedisChannelSubscriber {
  subscribeToChannel(channel: string): Promise<Observable<string>>;
}

export interface RedisChannelSseOptions {
  /** Redis channel to relay, e.g. `consultation:harness-progress:{id}`. */
  channel: string;
  /** Idle keep-alive period (proxies drop silent SSE streams). */
  heartbeatMs: number;
  /**
   * Late-join read, emitted BEFORE any relayed event. Channel events published while it is in
   * flight are buffered and replayed after it, so the ordering stays snapshot-first and nothing
   * is dropped.
   *
   * A `string[]` answer emits EVERY entry, in the order given — a lane whose late-join state
   * lives under more than one key (the live-summary channel caches the whole-document note under
   * `…:last` and the warm-start `presummary` event under `…:presummary:last`) owes a late joiner
   * both, primary document first. A single `string` behaves exactly as it always has.
   */
  loadSnapshot?: () => Promise<string | string[] | null | undefined>;
  /**
   * True when a relayed event carries state an emitted entry already had.
   *
   * `snapshot` is the FIRST emitted entry, so a single-value caller's two-argument predicate is
   * unchanged; `emitted` is every entry, in emission order, for a caller that emits more than one
   * and must therefore compare like with like (an event of one kind is never a duplicate of a
   * cached event of another).
   */
  isDuplicateOfSnapshot?: (raw: string, snapshot: string | null | undefined, emitted: readonly string[]) => boolean;
  /** True for the terminal event — it is emitted, then the stream completes. */
  isTerminal?: (raw: string) => boolean;
  /**
   * Tag each frame's SSE `type` from the relayed payload's OWN `event` field (opt-in).
   *
   * A channel that multiplexes several kinds of payload behind one JSON discriminator can say so
   * in the transport instead: Nest's `SseStream` writes `event: <type>` for a `MessageEvent.type`,
   * so `{"event":"section.patch",…}` arrives as a named frame that
   * `EventSource.addEventListener('section.patch', …)` receives and `onmessage` does not. A
   * payload carrying no string `event` — the undiscriminated whole-document snapshot, the
   * terminal `closed: true` — keeps the default `message` type, and so does everything on a
   * channel whose caller did not opt in. The JSON is never rewritten.
   *
   * Backward compatible for a consumer that folds `onmessage` payloads: it stops SEEING exactly
   * the payloads a discriminator told it to skip, and still receives every undiscriminated one.
   */
  tagFrameTypeFromPayload?: boolean;
  /** Serialized payload emitted (then completed) when setup fails. */
  setupErrorPayload: string;
  /** Context merged into the setup-failure log line. */
  logContext: Record<string, unknown>;
}

/**
 * One SSE relay over a shared, refcounted Redis pub/sub channel.
 *
 * Extracted because five hand-copied instances of this shape all carried the
 * same teardown race: the channel subscription is only assigned AFTER an
 * `await`, and RxJS runs the Observable teardown the instant a subscriber
 * leaves — so an aborted request (StrictMode double-mount, navigation during
 * load, EventSource reconnect) left the refcount incremented by
 * `subscribeToChannel` permanently held, pinning a Subject and a live Redis
 * SUBSCRIBE. The `cancelled` flag below is checked after every await and
 * releases whatever was just created.
 *
 * Teardown relies EXCLUSIVELY on the refcounted `finalize` inside
 * `subscribeToChannel`. Never call `unsubscribeFromChannel` from a relay: it
 * force-completes the SHARED per-channel Subject and starves every other
 * concurrent viewer.
 */
export function sseFromRedisChannel(
  redisSubscriber: RedisChannelSubscriber,
  logger: Logger,
  options: RedisChannelSseOptions,
): Observable<MessageEvent> {
  const { channel, heartbeatMs, loadSnapshot, isDuplicateOfSnapshot, isTerminal, tagFrameTypeFromPayload, setupErrorPayload, logContext } = options;

  // Replayed entries and relayed messages go through the SAME builder: a late joiner's cached
  // `presummary` must arrive on the same named frame as a live one, or a consumer listening by
  // event name would receive the live event and miss the replay.
  const toEvent = (raw: string): MessageEvent => {
    const type = tagFrameTypeFromPayload ? frameTypeOf(raw) : undefined;
    return (type === undefined ? { data: raw } : { data: raw, type }) as MessageEvent;
  };

  return new Observable<MessageEvent>((subscriber) => {
    let cancelled = false;
    let inner: Subscription | null = null;
    let bridgeSub: Subscription | null = null;

    const releaseIfCancelled = (): boolean => {
      if (!cancelled) return false;
      inner?.unsubscribe();
      bridgeSub?.unsubscribe();
      return true;
    };

    (async () => {
      const messages$ = await redisSubscriber.subscribeToChannel(channel);
      // Subscribe immediately: the refcount is already incremented, and only a
      // subscription to this observable can release it.
      const bridge = loadSnapshot ? new ReplaySubject<string>() : new Subject<string>();
      bridgeSub = messages$.subscribe(bridge);
      if (releaseIfCancelled()) return;

      let emitted: string[] = [];
      if (loadSnapshot) {
        const loaded = await loadSnapshot();
        if (releaseIfCancelled()) return;
        // An empty entry is dropped rather than emitted as a blank frame — same as the
        // single-value `if (snapshot)` guard this replaces.
        emitted = (Array.isArray(loaded) ? loaded : [loaded]).filter((entry): entry is string => typeof entry === 'string' && entry !== '');
        for (const entry of emitted) {
          subscriber.next(toEvent(entry));
        }
      }

      const relay$ = bridge.pipe(
        filter((raw: string) => !(isDuplicateOfSnapshot?.(raw, emitted[0] ?? null, emitted) ?? false)),
        map(toEvent),
      );

      const heartbeat$ = interval(heartbeatMs).pipe(
        map((): MessageEvent => ({ data: JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() }) }) as MessageEvent),
      );

      // takeWhile sits on the MERGED stream (not just the relay) so the terminal
      // event completes the whole SSE stream — the infinite heartbeat interval
      // would otherwise keep `merge` alive.
      const merged$ = merge(relay$, heartbeat$);
      const stream$ = isTerminal
        ? merged$.pipe(takeWhile((event: MessageEvent) => !isTerminal(event.data as string), true)) // include the terminal event
        : merged$;

      inner = stream$.subscribe({
        next: (event) => subscriber.next(event),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      releaseIfCancelled();
    })().catch((error) => {
      logger.error({
        message: 'Failed to initialise SSE subscription',
        channel,
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
      subscriber.next({ data: setupErrorPayload } as MessageEvent);
      subscriber.complete();
    });

    return () => {
      cancelled = true;
      inner?.unsubscribe();
      // Releasing the bridge drives the refcounted channel cleanup (last viewer
      // out tears the Redis subscription down).
      bridgeSub?.unsubscribe();
    };
  });
}

/**
 * The SSE frame type a payload names for itself: its own `event` field, when that is a non-empty
 * string. `undefined` for anything else — a payload with no discriminator, a non-string one, and
 * a message that is not JSON at all — all of which stay on the default `message` type.
 */
function frameTypeOf(raw: string): string | undefined {
  try {
    const event = (JSON.parse(raw) as { event?: unknown }).event;
    return typeof event === 'string' && event !== '' ? event : undefined;
  } catch {
    return undefined;
  }
}

/** `closed: true` terminal predicate shared by the consultation feeds. */
export function closedFlagTerminal(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { closed?: boolean }).closed === true;
  } catch {
    return false;
  }
}
