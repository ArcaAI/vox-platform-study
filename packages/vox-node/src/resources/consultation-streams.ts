/**
 * `hope.consultations.streams.*` — the four LIVE planes a consultation
 * publishes while it is being recorded (TASK-933).
 *
 * All four are SSE routes on
 * `apps/api/src/modules/consultation/consultation.controller.ts`, and this SDK
 * reads them off `response.body` with a header-authenticated request — never
 * `EventSource`, which cannot set `X-API-Key` or `X-Service-Account-Token`, and
 * never a `?ticket=` (that is the browser's affordance, for a client that
 * cannot set headers at all).
 *
 * ## The four are not the same shape, and the difference matters
 *
 * | Plane | Shape | Terminal event |
 * |---|---|---|
 * | `liveSummary` | THREE payload kinds multiplexed on one channel | a snapshot with `closed: true` |
 * | `liveAssist` | one snapshot, two independently-replaced branches. **PHI** | none — you close it |
 * | `harnessProgress` | snapshot fold: the FULL stage list every time | `closed: true` |
 * | `loop` | APPEND-ONLY: self-contained events, no fold, no replay | none — you close it |
 *
 * A consumer that treats the append-only planes as snapshots will render the
 * last event instead of the feed; one that treats the snapshot planes as a feed
 * will accumulate duplicates. Neither mistake is visible in the types alone,
 * which is why it is written here.
 */

import { subscribeToSse } from '../core/sse-subscription';
import type { StreamHandle, StreamHandlers, StreamHandlersBase, SubscribeOptions } from '../core/sse-subscription';
import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type {
  HarnessProgressEvent,
  LiveAssistEvent,
  LiveSummaryEvent,
  LoopEvent,
  PreSummaryEvent,
  SectionPatchEvent,
} from '../types/consultation-realtime';

/**
 * Handlers for the multiplexed live-summary channel.
 *
 * Only {@link onSnapshot} is required — a caller that has not adopted section
 * streaming still gets the whole-document view, which is exactly what the
 * legacy payload is for. `onError` is required for the reason in
 * `core/sse-subscription.ts`: a 403 must not vanish.
 */
export interface LiveSummaryHandlers extends StreamHandlersBase {
  /** The whole-document snapshot. Also the TERMINAL event, when it carries `closed: true`. */
  onSnapshot(event: LiveSummaryEvent): void;
  /** One section's new state. Discard any patch whose `revision` is not greater than the one you hold. */
  onSectionPatch?(event: SectionPatchEvent): void;
  /** The warm start's progress: `running` → `ready` | `degraded`. */
  onPreSummary?(event: PreSummaryEvent): void;
}

/** Discriminate one live-summary payload. The `event` field is IN THE JSON, not on the SSE frame. */
function isSectionPatch(payload: Record<string, unknown>): payload is SectionPatchEvent & Record<string, unknown> {
  return payload.event === 'section.patch';
}

function isPreSummary(payload: Record<string, unknown>): payload is PreSummaryEvent & Record<string, unknown> {
  return payload.event === 'presummary';
}

function streamPath(consultationId: string, segment: string): string {
  return `consultations/${encodePathSegment(consultationId)}/${segment}/stream`;
}

export class ConsultationStreamsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/v1/consultations/:id/live-summary/stream`.
   *
   * Ends itself on the terminal snapshot (`closed: true`), so a caller that
   * only wants the finished note does not have to watch for it.
   */
  liveSummary(consultationId: string, handlers: LiveSummaryHandlers, options: SubscribeOptions = {}): StreamHandle {
    return subscribeToSse(
      this.transport,
      {
        path: streamPath(consultationId, 'live-summary'),
        dispatch: (payload) => {
          if (typeof payload !== 'object' || payload === null) return;
          const record = payload as Record<string, unknown>;
          if (isSectionPatch(record)) {
            handlers.onSectionPatch?.(record);
            return;
          }
          if (isPreSummary(record)) {
            handlers.onPreSummary?.(record);
            return;
          }
          const snapshot = record as unknown as LiveSummaryEvent;
          handlers.onSnapshot(snapshot);
          return snapshot.closed === true;
        },
      },
      handlers,
      options,
    );
  }

  /**
   * `GET /api/v1/consultations/:id/live-assist/stream` — interpreter
   * suggestions and PROPOSED corrections.
   *
   * **This feed carries PHI**: a correction proposal quotes the span it would
   * replace, verbatim. Nothing on it has been applied to any note; the
   * clinician decides, and an accepted proposal is carried back on
   * `recording.stop({ acceptedProposals })`.
   *
   * No terminal event — close it when you are done.
   */
  liveAssist(consultationId: string, handlers: StreamHandlers<LiveAssistEvent>, options: SubscribeOptions = {}): StreamHandle {
    return this.subscribe(consultationId, 'live-assist', handlers, options);
  }

  /**
   * `GET /api/v1/consultations/:id/harness-progress/stream` — the draft
   * generation stage checklist. No PHI: ids, stage keys and states only.
   *
   * Every event carries the FULL accumulated stage list, so hold the latest and
   * discard the rest. Ends on `closed: true`.
   */
  harnessProgress(consultationId: string, handlers: StreamHandlers<HarnessProgressEvent>, options: SubscribeOptions = {}): StreamHandle {
    return subscribeToSse(
      this.transport,
      {
        path: streamPath(consultationId, 'harness-progress'),
        dispatch: (payload) => {
          const event = payload as HarnessProgressEvent;
          handlers.onEvent(event);
          return event?.closed === true;
        },
      },
      handlers,
      options,
    );
  }

  /**
   * `GET /api/v1/consultations/:id/loop/stream` — the agentic loop's activity
   * feed. APPEND-ONLY: accumulate, do not replace. No late-join replay, so
   * events published before you subscribed are not repeated; no terminal event.
   */
  loop(consultationId: string, handlers: StreamHandlers<LoopEvent>, options: SubscribeOptions = {}): StreamHandle {
    return this.subscribe(consultationId, 'loop', handlers, options);
  }

  private subscribe<TEvent>(consultationId: string, segment: string, handlers: StreamHandlers<TEvent>, options: SubscribeOptions): StreamHandle {
    return subscribeToSse(
      this.transport,
      {
        path: streamPath(consultationId, segment),
        dispatch: (payload) => {
          handlers.onEvent(payload as TEvent);
        },
      },
      handlers,
      options,
    );
  }
}
