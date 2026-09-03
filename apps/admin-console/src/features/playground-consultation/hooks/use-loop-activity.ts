'use client';

/**
 * W4 / R3 — the clinician-facing view of the agentic loop plane.
 *
 * The gateway relays `consultation:loop:{id}` as an APPEND-ONLY SSE feed
 * (`GET :id/loop/stream`, `LoopEventDto`): every message is self-contained,
 * there is no fold, no snapshot and no late-join replay. This module keeps
 * that shape and only normalises what the UI renders.
 *
 * Contract brokered from for the realtime-summary capability:
 *
 *   { kind: 'summary.interim', data: { kindKey, ordinal, total, chars } }
 *
 * **The event carries no summary text, by design** — the loop plane is a live
 * UI feed, not a PHI transport. So this surface renders PROGRESS ONLY. The
 * read-back that would supply the actual interim text is, which
 * is blocked on a schema column and is not started; until it lands
 * there is no body to show, and inventing a field the wire does not carry is
 * exactly the class of error struck two of its own findings for.
 */

/** Wire shape of one loop event (`LoopEventDto`). */
export interface LoopEvent {
  consultationId: string;
  tenantId?: string;
  runId?: string;
  kind: string;
  label?: string;
  data?: Record<string, unknown>;
  publishedAt: string;
}

/** One rendered row of the activity feed. Deliberately carries no note text. */
export interface LoopActivityEntry {
  kind: string;
  label?: string;
  publishedAt: string;
  /** `summary.interim` only — which SOAP section this chunk belongs to. */
  kindKey?: string;
  ordinal?: number;
  total?: number;
  chars?: number;
  /**
   * Always `undefined`. Present as an explicit, typed reminder that the loop
   * event has no body and that one must never be synthesised here — remove it
   * only when read-back actually supplies text.
 */
  body?: undefined;
}

/** The feed is bounded; a long consultation must not grow it without limit. */
const MAX_ENTRIES = 200;

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Appends one loop event to the feed. Pure, so the "no fabricated body"
 * property is testable without a component or a live stream.
 */
export function foldLoopActivity(feed: readonly LoopActivityEntry[], event: LoopEvent): LoopActivityEntry[] {
  const data = event.data ?? {};
  const entry: LoopActivityEntry = {
    kind: event.kind,
    label: event.label,
    publishedAt: event.publishedAt,
    kindKey: asString(data.kindKey),
    ordinal: asNumber(data.ordinal),
    total: asNumber(data.total),
    chars: asNumber(data.chars),
  };
  const next = [...feed, entry];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}
