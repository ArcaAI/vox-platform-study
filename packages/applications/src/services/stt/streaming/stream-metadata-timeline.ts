/**
 * TASK-951 R2 (clarified 2026-09-11) — the per-AUDIO-SPAN metadata timeline.
 *
 * ## Why a timeline and not a session field
 *
 * Lane E gave a stream session ONE `context`, read once at attach and echoed on every
 * transcript. That answers "which microphone is this session", which is enough when a session
 * IS a microphone. The owner's clarification is a different question:
 *
 * > *"the ALaaS can send 1 or 2 or more than 2 mic ids when recordings […] hope platform must
 * > return exactly the metadata contains mic ids time-synced with the generated transcript."*
 *
 * The set of live microphones CHANGES DURING a session. A session-level field cannot express
 * that: whatever value it holds when an utterance is transcribed would be stamped on segments
 * whose audio was captured under a different set. So the client's metadata is recorded as a
 * TIMELINE — a list of half-open spans on the session's own audio clock — and each transcript
 * carries the spans that overlap ITS window, clipped to it.
 *
 * ## The clock
 *
 * Spans are expressed in SESSION-RELATIVE SECONDS OF AUDIO, the same unit a segment's
 * `startTime`/`endTime` are in. That is what makes the two comparable at all, and it is not a
 * coincidence: `apps/stt` derives a segment's times from the SAMPLES IT HAS PROCESSED
 * (`preprocessor.py`: `end_time = state.total_samples_fed / self._target_sr`, and an
 * utterance's start from `state.total_samples_fed` at the confirmed onset), never from a wall
 * clock. The gateway's side of the same clock is `bytesForwarded / (sampleRate * 2)` for PCM16
 * LE mono. Two counters over the same audio, so they agree without anyone transmitting a
 * timestamp.
 *
 * A wall-clock design would have been wrong here even though it looks simpler: audio is
 * buffered, batched and (on a resume) replayed, so the instant a `metadata` frame ARRIVES is
 * not the instant of the audio it describes.
 *
 * ## Purity
 *
 * No Nest, no Redis, no clock of its own. Every function takes the spans and the offset it
 * should act at and returns a new value, which is what lets the exhaustive unit test pin the
 * awkward cases (coalescing, a same-offset replacement, an open final span, a window that
 * predates the first mark) without standing up a gateway.
 */

/**
 * One stretch of the session's audio during which a single metadata object was in force.
 *
 * Half-open: `[from, to)`. `to === null` means "still in force" — the last span is always open
 * until another `metadata` frame closes it, because a client says what IS true, never for how
 * long.
 */
export interface MetadataSpan {
  /** Session-relative audio seconds at which this value took effect. */
  from: number;
  /** Session-relative audio seconds at which it stopped, or `null` while it is still in force. */
  to: number | null;
  /** The client's object, VERBATIM. Never re-keyed, never normalized. */
  value: Record<string, unknown>;
}

/**
 * A span as it appears on a transcript: clipped to that segment's window, so both ends are
 * real numbers a consumer can place on the segment without knowing anything about the session.
 */
export interface ClippedMetadataSpan {
  from: number;
  to: number;
  value: Record<string, unknown>;
}

/**
 * What the gateway persists so a cross-instance reconnect (or a restarted pod) rebuilds the
 * timeline instead of silently starting a second one at zero.
 *
 * `audioSec` rides WITH the spans on purpose: the spans are meaningless without the clock they
 * were measured on, and an in-memory byte counter does not survive the process. It is the
 * offset as of the LAST recorded mark, so a rebuilt session's clock resumes there rather than
 * at zero — it can lag by however much audio flowed after that mark, which understates the
 * gap and never invents coverage.
 */
export interface StreamMetadataMarks {
  spans: MetadataSpan[];
  audioSec: number;
}

/** Hard ceiling on ONE metadata object, in bytes of `JSON.stringify` output (UTF-8). */
export const MAX_STREAM_METADATA_BYTES = 2048;

const encoder = new TextEncoder();

/**
 * Byte length of a value's JSON form.
 *
 * Bytes, not `.length`: a mic label may be non-ASCII, and a character count would admit an
 * object several times the intended Redis and per-utterance wire cost. Measured on
 * `JSON.stringify` output rather than the raw frame so whitespace in the client's framing is
 * not charged against its budget — the same rule, and the same expression, as lane E's
 * session-`context` bound.
 */
export function metadataByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

/** True when a parsed frame field is a plain JSON object (the only thing metadata may be). */
export function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Key-sorted JSON, used ONLY to decide whether two consecutive values are the same.
 *
 * Key order is an accident of how a client built its object; `{a,b}` and `{b,a}` describe the
 * same set of live microphones and must not open a new span between them. This is deliberately
 * not used for the size bound — there a client is charged for the bytes it actually sent.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Record that `value` is in force from `atSeconds` onward.
 *
 * Three behaviours the unit test pins, each of which is a real client sequence:
 *
 *  - **Coalesce.** A repeat of the value already in force changes nothing. A broker that
 *    re-states its mic set every few seconds (a perfectly reasonable thing to do over a lossy
 *    link) must not grow an unbounded list of adjacent identical spans, and a transcript must
 *    not come back carrying six spans that all say the same thing.
 *  - **Replace at the same offset.** Two frames before any audio flows both land at 0.0. The
 *    second REPLACES the first rather than opening a zero-length span — the first was never in
 *    force over any audio, so reporting it would be reporting a fiction.
 *  - **Never rewind.** `atSeconds` is clamped to the open span's `from`. The clock is derived
 *    from bytes forwarded and only ever increases; clamping means a caller that hands in a
 *    stale offset (a rebuilt timeline whose persisted `audioSec` lagged) produces a degenerate
 *    order rather than a span that ends before it starts.
 *
 * Returns THE SAME ARRAY INSTANCE when it coalesced, a new one otherwise. That identity IS the
 * "did anything change?" answer, and the gateway reads it as one — so a re-stated value writes
 * nothing to Redis, rather than the caller re-deriving the comparison and eventually
 * disagreeing with this function about what counts as a change.
 */
export function setMetadataAt(spans: readonly MetadataSpan[], atSeconds: number, value: Record<string, unknown>): MetadataSpan[] {
  const at = Number.isFinite(atSeconds) && atSeconds > 0 ? atSeconds : 0;
  const last = spans.length > 0 ? spans[spans.length - 1] : undefined;

  if (last && stableJson(last.value) === stableJson(value)) {
    return spans as MetadataSpan[];
  }

  if (!last) {
    return [{ from: at, to: null, value }];
  }

  const boundary = Math.max(at, last.from);
  if (boundary === last.from) {
    // Nothing has been in force over any audio yet — overwrite rather than record a
    // zero-length span no segment could ever overlap.
    return [...spans.slice(0, -1), { from: last.from, to: null, value }];
  }

  return [...spans.slice(0, -1), { ...last, to: boundary }, { from: boundary, to: null, value }];
}

/**
 * The spans overlapping `[startTime, endTime]`, clipped to it, in time order.
 *
 * `openEnd` is the session's current audio offset, handed in by the caller at EMIT time (never
 * captured when the subscription was created — the whole point is that it moves). It only ever
 * matters for the still-open final span, and it is combined as `max(openEnd, endTime)` rather
 * than used directly: a still-open span is in force "until further notice", so it covers the
 * whole of any window that reaches into it. Clipping it to a byte counter that momentarily
 * lags the ASR's sample counter — which happens whenever the service carries buffered audio —
 * would end a span short of the segment it describes, or drop it entirely and hand back an
 * empty array for a segment that plainly had metadata.
 *
 * A window that starts before the first mark simply gets no coverage for that stretch. Nothing
 * WAS in force then, and inventing a value for it would be worse than the gap.
 */
export function clipSpansToWindow(spans: readonly MetadataSpan[], startTime: number, endTime: number, openEnd: number): ClippedMetadataSpan[] {
  if (spans.length === 0) return [];

  const windowStart = Number.isFinite(startTime) ? startTime : 0;
  const windowEnd = Number.isFinite(endTime) ? endTime : windowStart;
  if (windowEnd < windowStart) return [];

  const openBoundary = Math.max(Number.isFinite(openEnd) ? openEnd : 0, windowEnd);
  const clipped: ClippedMetadataSpan[] = [];

  for (const span of spans) {
    const spanEnd = span.to ?? openBoundary;
    const from = Math.max(span.from, windowStart);
    const to = Math.min(spanEnd, windowEnd);
    // `>=` on a ZERO-WIDTH window (a partial whose start and end coincide) would drop every
    // span, so an instantaneous window still reports what was in force at that instant.
    if (to < from) continue;
    if (to === from && windowEnd > windowStart) continue;
    clipped.push({ from, to, value: span.value });
  }

  return clipped;
}

/**
 * The ONE metadata object a segment is reported under — the v1 wire shape (`transcript.metadata`
 * was the client's blob, flat), kept because that is what an integrator's speaker-labelling code
 * already reads (`metadata.mic_id`).
 *
 * Chosen from the segment's CLIPPED spans: the value in force over the LARGEST share of its audio;
 * a tie goes to the EARLIER span (what was in force when the segment started). A zero-width window
 * has one instantaneous span and that is the answer. `undefined` when there are no spans — the
 * caller omits the field, exactly as it omits `metadataSpans`.
 *
 * The full boundaries stay available beside it as `metadataSpans`, so a consumer that wants to
 * split a segment that straddled a microphone switch can; this picks the label for one that does
 * not want to.
 */
export function metadataInForce(clipped: readonly ClippedMetadataSpan[]): Record<string, unknown> | undefined {
  let best: ClippedMetadataSpan | undefined;
  let bestShare = -1;
  for (const span of clipped) {
    const share = span.to - span.from;
    // Strict `>`: an equal share never displaces the span that came first.
    if (share > bestShare) {
      best = span;
      bestShare = share;
    }
  }
  return best?.value;
}

/**
 * Rebuild a timeline from whatever came back out of Redis.
 *
 * TOTAL by design: a record this cannot read yields an EMPTY timeline, never a throw. The
 * echo is an attribution aid; a corrupt or half-written marks record must cost a client its
 * mic labels, never its live transcription — the same posture the sampleRate and session-echo
 * reads already take at the same seam. Entries are kept only while they stay monotonic, so a
 * record that was rewritten out of order truncates rather than producing spans that overlap.
 */
export function parseMetadataMarks(raw: unknown): StreamMetadataMarks {
  const empty: StreamMetadataMarks = { spans: [], audioSec: 0 };
  if (!isMetadataObject(raw)) return empty;

  const rawSpans = Array.isArray(raw.spans) ? raw.spans : [];
  const spans: MetadataSpan[] = [];
  let cursor = 0;

  for (const entry of rawSpans) {
    if (!isMetadataObject(entry)) break;
    const { from, to, value } = entry as { from?: unknown; to?: unknown; value?: unknown };
    if (typeof from !== 'number' || !Number.isFinite(from) || from < cursor) break;
    if (!isMetadataObject(value)) break;
    const closedAt = typeof to === 'number' && Number.isFinite(to) && to >= from ? to : null;
    spans.push({ from, to: closedAt, value });
    cursor = closedAt ?? from;
    // Only the LAST span may be open; an open span mid-list means the record is inconsistent.
    if (closedAt === null) break;
  }

  const audioSec = typeof raw.audioSec === 'number' && Number.isFinite(raw.audioSec) && raw.audioSec > 0 ? raw.audioSec : 0;
  return { spans, audioSec: Math.max(audioSec, cursor) };
}
