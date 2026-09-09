/**
 * TASK-933 — the HANDLER shape of an SSE read, beside the generator shape the
 * rest of this package uses.
 *
 * ## Why two shapes and not one
 *
 * `for await (const event of hope.jobs.stream(id))` is the right ergonomics for
 * ONE stream a caller waits on. The consultation realtime planes are the other
 * case: an integrator subscribes to four of them AT ONCE, alongside a live audio
 * socket, and none of them is the thing it is waiting for. Written as
 * generators that is four floating `void (async () => …)()` blocks with
 * hand-rolled cancellation; written as subscriptions it is four calls and four
 * `close()`s.
 *
 * The generator surface is unchanged — this is built ON `parseSseStream`, not
 * instead of it.
 *
 * ## `onError` is REQUIRED, deliberately
 *
 * A subscription is fire-and-forget: nothing awaits the promise it starts. A
 * 403 from the gateway (the shape of "this credential lacks the scope") would
 * therefore vanish into an unhandled rejection, which is the single most
 * expensive failure mode a machine integration can have — it looks exactly like
 * "the consultation is quiet". Making the handler mandatory costs one line at
 * every call site and removes that failure entirely.
 */

import { parseSseStream } from './sse';
import type { Transport, TransportRequestOptions } from './transport';

/**
 * The per-request timeout applied to a subscription: ~24.8 days, i.e. the
 * largest value a 32-bit timer accepts without being clamped (and warned about)
 * by the runtime.
 *
 * A live consultation plane is open-ended and often SILENT — a clinician
 * listening, a warm start still running — so the transport's 60-second default
 * would abort a perfectly healthy stream and report it as a timeout. There is
 * no "no timeout" option on the transport, and adding one would be a change to
 * a frozen module for the benefit of one caller.
 */
const SSE_SUBSCRIPTION_TIMEOUT_MS = 2_147_483_647;

/** What a subscription hands back. Idempotent: calling `close()` twice is a no-op. */
export interface StreamHandle {
  /**
   * Stop reading and release the connection. Safe to call at any point,
   * including before the stream has finished opening.
   */
  close(): void;
}

/** Why a subscription ended. */
export type StreamCloseReason =
  /** A domain-terminal event arrived (`closed: true`, or a terminal job status). */
  | 'terminal'
  /** The server closed the connection with no terminal event — normal on the append-only planes. */
  | 'end'
  /** {@link StreamHandle.close} was called. */
  | 'aborted';

/** Handlers shared by every subscription. */
export interface StreamHandlersBase {
  /**
   * Called once when the stream ends, whatever ended it. Never called after
   * {@link StreamHandlers.onError}.
   */
  onClosed?(reason: StreamCloseReason): void;
  /**
   * Called once with the failure that ended the stream — a non-2xx response
   * (an `HopeAPIError` subclass), a connection failure, or a throw from one of
   * your own handlers. Required; see this module's header.
   */
  onError(error: unknown): void;
}

/** The single-payload subscription shape. */
export interface StreamHandlers<TEvent> extends StreamHandlersBase {
  onEvent(event: TEvent): void;
}

/** Per-call options for a subscription. */
export interface SubscribeOptions {
  /** Aborting this is equivalent to calling `close()`. */
  signal?: AbortSignal;
}

/** What {@link subscribeToSse} does with each decoded frame. */
export interface SseSubscriptionSpec {
  /** The gateway-relative path, e.g. `consultations/c1/live-summary/stream`. */
  path: string;
  query?: TransportRequestOptions['query'];
  /**
   * Dispatch one decoded payload. Return `true` to END the subscription with
   * reason `'terminal'` — that is how a `closed: true` snapshot or a terminal
   * job status stops the read without the caller having to.
   */
  dispatch(payload: unknown, event: string): boolean | void;
}

/**
 * Open an SSE read and pump its frames into `spec.dispatch`, returning a handle
 * synchronously.
 *
 * A frame whose `data` is not JSON is SKIPPED, not thrown: one malformed frame
 * must not destroy a stream whose remaining frames are fine, and the
 * consultation is unaffected by our inability to read one event. That is the
 * same rule `resources/workflows.ts#toRunEvent` follows.
 */
export function subscribeToSse(
  transport: Transport,
  spec: SseSubscriptionSpec,
  handlers: StreamHandlersBase,
  options: SubscribeOptions = {},
): StreamHandle {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let settled = false;

  const finish = (reason: StreamCloseReason): void => {
    if (settled) return;
    settled = true;
    handlers.onClosed?.(reason);
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    handlers.onError(error);
  };

  void (async () => {
    try {
      const response = await transport.stream({
        path: spec.path,
        query: spec.query,
        headers: { Accept: 'text/event-stream' },
        signal,
        // An SSE read is open-ended by nature; the per-request timeout that
        // protects an ordinary call would abort a quiet consultation.
        timeoutMs: SSE_SUBSCRIPTION_TIMEOUT_MS,
      });
      if (!response.body) {
        finish('end');
        return;
      }

      for await (const frame of parseSseStream(response.body, { signal })) {
        let payload: unknown;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (spec.dispatch(payload, frame.event) === true) {
          controller.abort();
          finish('terminal');
          return;
        }
      }
      finish('end');
    } catch (error) {
      if (controller.signal.aborted) {
        finish('aborted');
        return;
      }
      fail(error);
    }
  })();

  return {
    close(): void {
      if (!controller.signal.aborted) controller.abort();
      finish('aborted');
    },
  };
}
