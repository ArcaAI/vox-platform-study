/**
 * TASK-946 D6 — the CLOSED vocabulary of PHI-safe degrade reasons, and the one classifier.
 *
 * ## What this replaces
 *
 * Two surfaces published a failure reason and neither published a reason. The warm start's
 * `degradeReason()` answered `error.name`, so the clinician's feed carried `AxiosError` — a fact
 * about the HTTP client. The flush's `realtimeDegradeReason` answered `${status}: ${message}`, so
 * the `section.patch` envelope carried `degraded: Request failed with status code 502`. Both are
 * transport strings: they tell a reader nothing about the consultation, and a MESSAGE is the one
 * field on these surfaces that can carry clinical text out of a model's own refusal.
 *
 * ## The vocabulary
 *
 * Four codes are SHARED, because they are facts about the world that any surface can meet:
 *
 * | code | what it means |
 * |---|---|
 * | `no_case_notes` | the ordinary case, not a fault: a first-ever visit has no prior record |
 * | `context_overflow` | the prompt did not fit the model's context window |
 * | `text_unavailable` | the TEXT service could not be reached, or answered 5xx |
 * | `timeout` | the call, or the node's own budget, ran out |
 *
 * The fifth code is each surface's TERMINAL FALLBACK, and there are deliberately two of them:
 * a failed flush is not a failed pre-summary, and reporting one as the other on the clinician's
 * feed would be a falsehood in the field that exists to explain what happened.
 *
 * An input that is ALREADY a code passes through unchanged — the realtime executor's own reasons
 * (`unsupported_node_type`, `branch_not_taken`, `superseded_after_completion`, …) are codes by
 * construction, and re-classifying them would throw away the more specific answer.
 */

/** The terminal fallback for the LIVE FLUSH: generation was attempted and produced no note. */
export const LIVE_DEGRADE_FALLBACK = 'generation_failed';

/** The terminal fallback for the WARM-START pre-summary. */
export const PRE_SUMMARY_DEGRADE_FALLBACK = 'pre_summary_failed';

/** The four shared codes, plus both terminal fallbacks — the whole vocabulary, in one place. */
/**
 * TASK-1000 — the model stopped at its OUTPUT cap, so the response is a partial document.
 *
 * Deliberately NOT `context_overflow`, which is the opposite end of the same window: that one
 * says the PROMPT did not fit and the remedy is to send less; this one says the ANSWER did not
 * fit and the remedy is to raise the budget. Folding them would tell an operator to shrink the
 * input of a call whose input was never the problem.
 */
export const LIVE_DEGRADE_OUTPUT_TRUNCATED = 'output_truncated';

/**
 * TASK-1001 (OD-6) — the model is RE-SAYING what the note already records, and the turn contract
 * is absorbing it.
 *
 * Unlike every other code here, this one is not a failure. The flush SUCCEEDED and the note is
 * publishable; what it reports is that the generation spent this turn restating itself and only
 * the append guard kept the repeats out of the clinician's note. That is worth a code precisely
 * because it is invisible otherwise: in the reported incident 11 of 13 flushes carried refusals,
 * peaking at 4 in one flush, and no field on any surface said so — the note simply came back with
 * the same clinical statements six times over, and the first anyone knew of it was a tester
 * reading it.
 *
 * Deliberately NOT `LIVE_DEGRADE_FALLBACK`: a reader that treats every code as "there is no note"
 * would hide a note that exists. It is published beside `turnDegraded`, the surface's existing
 * quality-of-a-successful-flush signal, and never as the whole-document payload's `degradeReason`.
 */
export const LIVE_DEGRADE_REPETITION_PRESSURE = 'repetition_pressure';

export const LIVE_DEGRADE_CODES = Object.freeze([
  'no_case_notes',
  'context_overflow',
  'text_unavailable',
  'timeout',
  LIVE_DEGRADE_OUTPUT_TRUNCATED,
  LIVE_DEGRADE_REPETITION_PRESSURE,
  LIVE_DEGRADE_FALLBACK,
  PRE_SUMMARY_DEGRADE_FALLBACK,
] as const);

export type LiveDegradeCode = (typeof LIVE_DEGRADE_CODES)[number];

/** A reason the caller already expressed as a code: lower snake_case, nothing else. */
const BARE_CODE = /^[a-z][a-z0-9_]*$/;

const NO_CASE_NOTES = /no case notes/i;
/** Context-window wording across the providers we front, plus the size/length forms they use. */
const CONTEXT_OVERFLOW =
  /context[ _-]?(window|length|size)|exceeds? the (model'?s? )?context|too (long|many tokens)|maximum context|prompt is too large/i;
const TIMEOUT = /\btimed?[ _-]?out\b|\btimeout\b|budget[ _]exceeded|etimedout|econnaborted/i;
const UNAVAILABLE = /econnrefused|econnreset|enotfound|ehostunreach|socket hang up|service unavailable|bad gateway|status code 5\d\d/i;

/** The JSON error body the transport carried, when it carried an object. */
function responseBody(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { response } = error as { response?: { data?: unknown } };
  const data = response?.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
}

/** A `detail` that is an object — the provider-4xx shape's `{ error, code }` envelope. */
function detailObject(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const detail = body?.detail;
  return typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : undefined;
}

/**
 * The upstream error CODE, across every shape `apps/text` emits.
 *
 * `code` alone was not enough, and `data.code` was never right: text writes the code at
 * `data.error_code` (its `TextError` handler) or at `data.detail.code` (a provider 4xx raised as
 * a FastAPI `HTTPException` with a dict detail). `data.code` is kept because it costs nothing and
 * a peer that does use it should not silently stop being understood.
 */
function upstreamCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { code } = error as { code?: unknown };
  const body = responseBody(error);
  return [code, body?.code, body?.error_code, detailObject(body)?.code].filter((value): value is string => typeof value === 'string').join(' ');
}

/**
 * The upstream error MESSAGE, for WORDING checks only.
 *
 * Every engine phrases a context overflow differently and none hands back a machine-readable
 * field for it, so the prose is the only signal when the code is the generic
 * `PROVIDER_INVALID_REQUEST`. This value is matched against and NEVER returned: `degradeCode`
 * answers from the closed vocabulary or its caller's fallback, which is what keeps a model's own
 * refusal — and any clinical text in it — off a clinician-facing feed.
 */
function upstreamMessage(error: unknown): string {
  const body = responseBody(error);
  const detail = body?.detail;
  if (typeof detail === 'string') return detail;
  const nested = detailObject(body)?.error;
  return typeof nested === 'string' ? nested : '';
}

/** The HTTP status, when the transport carried one. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Classify one failure into the vocabulary above.
 *
 * `fallback` is the surface's terminal code — pass {@link LIVE_DEGRADE_FALLBACK} or
 * {@link PRE_SUMMARY_DEGRADE_FALLBACK}, never an ad-hoc string: the whole point of a closed
 * vocabulary is that a consumer can enumerate it.
 *
 * NEVER returns the input message. Anything unrecognised becomes `fallback`, which is what makes
 * this safe to publish on a clinician-facing feed regardless of what an upstream service said.
 */
export function degradeCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  const codes = upstreamCode(error);
  const status = httpStatus(error);
  const haystack = `${codes} ${message} ${upstreamMessage(error)}`;

  // TASK-1000 — `TruncatedGenerationError` declares `code = 'output_truncated'`, which
  // `upstreamCode` already surfaces, so this classifies structurally with no import and no
  // coupling to the module that raises it. First, so no wording regex can claim it: a truncated
  // note's own text may say anything at all.
  if (codes.split(/\s+/).includes(LIVE_DEGRADE_OUTPUT_TRUNCATED)) return LIVE_DEGRADE_OUTPUT_TRUNCATED;
  if (/CONTEXT_WINDOW_EXCEEDED/i.test(codes)) return 'context_overflow';
  if (NO_CASE_NOTES.test(message)) return 'no_case_notes';
  if (CONTEXT_OVERFLOW.test(haystack)) return 'context_overflow';
  if (TIMEOUT.test(haystack)) return 'timeout';
  if ((status !== undefined && status >= 500) || UNAVAILABLE.test(haystack)) return 'text_unavailable';
  // Already a code — the realtime executor's own reasons arrive this way, and they are more
  // specific than anything this function could say about them.
  if (BARE_CODE.test(message.trim())) return message.trim();
  return fallback;
}

/**
 * TASK-1001 (OD-6) — how much repetition in ONE flush is worth reporting.
 *
 * ## Why 3, and why a SUM
 *
 * The turn contract refuses or drops a contribution for ordinary reasons all the time: a model
 * re-stating one section it wrote a minute ago is the normal background of an additive contract,
 * and a threshold of "any" would have fired on 11 of the reported incident's 13 flushes. A signal
 * that fires on 85% of flushes is not a signal — it is the `AxiosError` problem again, one
 * surface saying something on every flush and therefore saying nothing.
 *
 * Three is the first count that cannot be one ordinary restatement:
 *  - the incident's WORST flush carried 4 refusals, so it fires there, which is the case an
 *    operator needed to see;
 *  - under Phase 4's sentence-level dedup each of the observed shapes — the `S1 + S2` superset
 *    restatement, the whitespace variant, the re-ordering — drops SEVERAL already-stored
 *    sentences in a single addition, so the repetitive flushes reach 3 on dropped sentences
 *    alone, well before a refusal count would have;
 *  - a flush with one refusal and one dropped sentence stays quiet, which is what makes the
 *    fired ones legible.
 *
 * The two counts are SUMMED rather than thresholded separately because they are two measurements
 * of one behaviour at two granularities — a whole refused revision and a dropped sentence inside
 * an accepted addition are the same model doing the same thing — and a per-count threshold would
 * miss the flush that does a little of each.
 *
 * It is a per-FLUSH threshold, not a rolling window: a session-wide counter answers "was this
 * consultation repetitive", which is a question about the past, while this one has to be
 * answerable on the flush it describes, beside that flush's own stats.
 */
export const LIVE_REPETITION_PRESSURE_THRESHOLD = 3;

/**
 * Classify one flush's repetition counts.
 *
 * Returns {@link LIVE_DEGRADE_REPETITION_PRESSURE} when the flush is repetitive enough to report,
 * and `undefined` otherwise — `undefined` rather than a boolean so a caller spreads the result
 * straight into the telemetry it is already building, exactly as `degradeCode`'s output is used.
 */
export function repetitionPressureCode(counts: { refusedRewrites: number; droppedSentences: number }): string | undefined {
  const total = Math.max(0, counts.refusedRewrites) + Math.max(0, counts.droppedSentences);
  return total >= LIVE_REPETITION_PRESSURE_THRESHOLD ? LIVE_DEGRADE_REPETITION_PRESSURE : undefined;
}
