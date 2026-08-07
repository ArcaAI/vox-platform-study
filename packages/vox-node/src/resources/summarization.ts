/**
 * P0 — stateless, v1-compat summarization. No consultation required: POST a
 * transcript, get a summary/pre-summary back. Backed by the frozen v1-compat
 * shims (`apps/api/src/modules/smr-compat/smr-compat.controller.ts`), whose
 * paths are exempt from the gateway's `api/v1` prefix — `core/url.ts#buildUrl`
 * already special-cases them, so this module passes the literal compat paths
 * straight through without touching the prefix logic itself.
 */

import { HopeStreamError } from '../core/errors';
import type { SseFrame } from '../core/sse';
import { parseSseStream } from '../core/sse';
import type { Transport } from '../core/transport';
import type {
  PreSummaryRequest,
  PreSummaryResponse,
  PreSummaryStreamEvent,
  SummaryResponse,
  SummaryStreamEvent,
  SyncSummaryRequest,
} from '../types/summarization';

/** Prefix-exempt (see `core/url.ts#PREFIX_EXEMPT_PATHS`) — do not prepend `api/v1`. */
const PRESUMMARY_PATH = 'api/smr/api/v1/presummary';
/** Prefix-exempt (see `core/url.ts#PREFIX_EXEMPT_PATHS`) — do not prepend `api/v1`. */
const SUMMARY_PATH = 'api/smr/api/v1/summary/sync';

/** Per-call options shared by every method on {@link SummarizationResource}. */
export interface SummarizationRequestOptions {
  signal?: AbortSignal;
}

/**
 * An `AsyncIterable` of stream events that also exposes `.result()` — a
 * convenience that consumes the stream to completion and returns just the
 * terminal payload, for the common case of "I want the answer, not the
 * deltas". Like any async generator, the underlying stream can only be
 * consumed ONCE: iterate it with `for await` OR call `.result()`, not both.
 */
export interface SummarizationStream<TEvent, TResult> extends AsyncIterable<TEvent> {
  /**
   * Consume the stream to completion. Resolves with the `result` frame's
   * payload; rejects with {@link HopeStreamError} on an `error` frame, or if
   * the stream ends without ever emitting a `result` frame.
   */
  result(): Promise<TResult>;
}

function parseJsonData<T>(frame: SseFrame): T {
  return JSON.parse(frame.data) as T;
}

/** Map one raw SSE frame to the typed union event, or `null` for a frame this SDK doesn't surface (unknown `event:` names — comment-only `:keepalive` frames never reach here, `core/sse.ts` already drops them). */
function mapFrame<TEvent>(frame: SseFrame): TEvent | null {
  switch (frame.event) {
    case 'delta':
    case 'reasoning': {
      const { text } = parseJsonData<{ text: string }>(frame);
      return { type: frame.event, text } as unknown as TEvent;
    }
    case 'result':
      return { type: 'result', data: parseJsonData<unknown>(frame) } as unknown as TEvent;
    case 'error': {
      const { detail } = parseJsonData<{ detail: string }>(frame);
      return { type: 'error', detail } as unknown as TEvent;
    }
    default:
      return null;
  }
}

/** Attach a `.result()` method to an already-constructed async generator, per {@link SummarizationStream}. */
function withResult<TEvent extends { type: string }, TResult>(generator: AsyncGenerator<TEvent, void, void>): SummarizationStream<TEvent, TResult> {
  const stream = generator as AsyncGenerator<TEvent, void, void> & { result: () => Promise<TResult> };
  stream.result = async () => {
    for await (const event of generator) {
      if (event.type === 'error') throw new HopeStreamError((event as unknown as { detail: string }).detail);
      if (event.type === 'result') return (event as unknown as { data: TResult }).data;
    }
    throw new HopeStreamError('Stream ended without a terminal result frame.');
  };
  return stream;
}

export class SummarizationResource {
  constructor(private readonly transport: Transport) {}

  /** `POST /api/smr/api/v1/presummary` (`stream` omitted from the caller-supplied body — this method always sends `stream: false`). */
  async preSummary(request: Omit<PreSummaryRequest, 'stream'> = {}, options: SummarizationRequestOptions = {}): Promise<PreSummaryResponse> {
    return this.transport.request<PreSummaryResponse>({
      method: 'POST',
      path: PRESUMMARY_PATH,
      body: { ...request, stream: false },
      signal: options.signal,
    });
  }

  /** `POST /api/smr/api/v1/summary/sync` (`stream` omitted from the caller-supplied body — this method always sends `stream: false`). */
  async summary(request: Omit<SyncSummaryRequest, 'stream'>, options: SummarizationRequestOptions = {}): Promise<SummaryResponse> {
    return this.transport.request<SummaryResponse>({
      method: 'POST',
      path: SUMMARY_PATH,
      body: { ...request, stream: false },
      signal: options.signal,
    });
  }

  /** `POST /api/smr/api/v1/presummary` with `stream: true` — SSE `delta`/`reasoning`/`result`/`error` frames. */
  preSummaryStream(
    request: Omit<PreSummaryRequest, 'stream'> = {},
    options: SummarizationRequestOptions = {},
  ): SummarizationStream<PreSummaryStreamEvent, PreSummaryResponse> {
    return withResult<PreSummaryStreamEvent, PreSummaryResponse>(this.openStream(PRESUMMARY_PATH, request, options));
  }

  /** `POST /api/smr/api/v1/summary/sync` with `stream: true` — SSE `delta`/`reasoning`/`result`/`error` frames. */
  summaryStream(
    request: Omit<SyncSummaryRequest, 'stream'>,
    options: SummarizationRequestOptions = {},
  ): SummarizationStream<SummaryStreamEvent, SummaryResponse> {
    return withResult<SummaryStreamEvent, SummaryResponse>(this.openStream(SUMMARY_PATH, request, options));
  }

  private openStream<TEvent extends { type: string }>(
    path: string,
    request: Record<string, unknown>,
    options: SummarizationRequestOptions,
  ): AsyncGenerator<TEvent, void, void> {
    const { transport } = this;
    return (async function* generate() {
      const response = await transport.stream({
        method: 'POST',
        path,
        body: { ...request, stream: true },
        headers: { Accept: 'text/event-stream' },
        signal: options.signal,
      });
      if (!response.body) {
        throw new HopeStreamError('Streaming response had no body.');
      }
      for await (const frame of parseSseStream(response.body, { signal: options.signal })) {
        const event = mapFrame<TEvent>(frame);
        if (event) yield event;
      }
    })();
  }
}
