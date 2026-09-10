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
export const LIVE_DEGRADE_CODES = Object.freeze([
  'no_case_notes',
  'context_overflow',
  'text_unavailable',
  'timeout',
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

/** The upstream error CODE, when the transport carried one (`{ code }`, or a JSON body's). */
function upstreamCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { code, response } = error as { code?: unknown; response?: { data?: unknown } };
  const bodyCode = typeof response?.data === 'object' && response.data !== null ? (response.data as { code?: unknown }).code : undefined;
  return [code, bodyCode].filter((value): value is string => typeof value === 'string').join(' ');
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
  const haystack = `${codes} ${message}`;

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
