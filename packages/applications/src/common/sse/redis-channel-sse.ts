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
   * Late-join snapshot read, emitted BEFORE any relayed event. Channel events
   * published while it is in flight are buffered and replayed after it, so the
   * ordering stays snapshot-first and nothing is dropped.
   */
  loadSnapshot?: () => Promise<string | null | undefined>;
  /** True when a relayed event carries state the emitted snapshot already had. */
  isDuplicateOfSnapshot?: (raw: string, snapshot: string | null | undefined) => boolean;
  /** True for the terminal event — it is emitted, then the stream completes. */
  isTerminal?: (raw: string) => boolean;
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
  const { channel, heartbeatMs, loadSnapshot, isDuplicateOfSnapshot, isTerminal, setupErrorPayload, logContext } = options;

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

      let snapshot: string | null | undefined = null;
      if (loadSnapshot) {
        snapshot = await loadSnapshot();
        if (releaseIfCancelled()) return;
        if (snapshot) {
          subscriber.next({ data: snapshot } as MessageEvent);
        }
      }

      const relay$ = bridge.pipe(
        filter((raw: string) => !(isDuplicateOfSnapshot?.(raw, snapshot) ?? false)),
        map((raw: string): MessageEvent => ({ data: raw }) as MessageEvent),
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

/** `closed: true` terminal predicate shared by the consultation feeds. */
export function closedFlagTerminal(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { closed?: boolean }).closed === true;
  } catch {
    return false;
  }
}
