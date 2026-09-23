/**
 * shared bounded JSON auto-repair.
 *
 * A structured-output (`response_format: json_schema`) generation can still come
 * back as malformed JSON on engines that only *soft*-honour the schema. This
 * helper wraps a generation call with a SINGLE bounded corrective retry: when the
 * first response does not parse strictly AND the engine was actually asked for
 * structured output, it regenerates ONCE with the seeded `CORRECTIVE_RETRY`
 * instruction appended, then parses that. The tolerant parser is always the final
 * fallback — a repair is best-effort and never blocks the caller.
 *
 * It is deliberately transport-agnostic, and BOTH paths drive it — the live-doc
 * flush and the durable finalize summary (which previously would persist a
 * malformed structured response verbatim as the clinical note):
 * the caller supplies the `generate` closure (which performs the actual TEXT call,
 * measures latency, captures stats, …), the strict parser, and the tolerant
 * fallback. The helper returns every model call it made (in order) so the caller
 * can record an ordered trajectory step — or attribute token cost — per call.
 */

/**
 * Canonical `CORRECTIVE_RETRY` instruction, mirrored byte-for-byte from the
 * seeded prompt-template row (`packages/database/.../seed/07-prompt-template.ts`
 * → `CORRECTIVE_RETRY_SUFFIX`, template id `TEMPLATE_IDS.CORRECTIVE_RETRY`).
 * Appended to the regeneration prompt on the one bounded auto-repair retry so the
 * corrective content is identical whether it is resolved from the DB or applied
 * inline on the realtime hot path.
 *
 * TASK-1001 (owner directive 2026-09-23: "all pre-summary and summary must be in
 * english, therefore, prompt instructions and configuration must be set to
 * english") — the language rule names ENGLISH, whatever language was spoken. It
 * used to demand "the conversation language" and forbid English words, which
 * contradicted the English output every summary path now states.
 */
export const CORRECTIVE_RETRY_INSTRUCTION = `\n\nREVISE STRICTLY:
- Do NOT use placeholders like 'Not documented' or 'Summary not available'.
- Monolingual rule: All headings/labels and descriptive content inside values MUST be in English, whatever language was spoken.
- Respond ONLY with a valid single JSON object (no pre/post text).
- Provide a best‑effort concise summary from available information.`;

/**
 * Strip an optional ```` ```json ```` code fence, returning the bare candidate.
 * Shared by the shape sniff and the strict parse so both agree on what the engine
 * "meant" to send.
 */
function unfence(text: string): string {
  let candidate = (text ?? '').trim();
  const fence = candidate.match(/^```(?:json)?\s*\n?/i);
  if (fence) {
    candidate = candidate.slice(fence[0].length).trimStart();
    const closing = candidate.lastIndexOf('```');
    if (closing >= 0) {
      candidate = candidate.slice(0, closing).trimEnd();
    }
  }
  return candidate;
}

/**
 * True when `text` looks like a JSON *object* attempt (optionally wrapped in a
 * ```` ```json ```` code fence). Used to scope the corrective retry to a genuine
 * malformed-JSON case: an engine that returned clean prose (no leading `{`) is
 * handled by the tolerant parser and must NOT trigger a wasted regeneration.
 */
export function looksLikeJsonObject(text: string): boolean {
  return unfence(text).startsWith('{');
}

/**
 * True when `text` actually parses as a JSON *object* (not an array/scalar).
 *
 * The generic strict check for callers whose payload is opaque JSON they persist
 * verbatim — they need to know only WHETHER the structured contract was honoured,
 * not to destructure it. Callers with a domain shape (e.g. the live-doc flush and
 * its SOAP schema) supply their own richer `parseStrict` instead.
 */
export function parsesAsJsonObject(text: string): boolean {
  const candidate = unfence(text);
  if (!candidate.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Minimum shape of a model call result the helper needs (the raw text to parse). */
export interface JsonRepairCall {
  text: string;
}

/**
 * What the ONE corrective retry is given (TASK-1000).
 *
 * It used to be a bare corrective string. The retry now also carries a `maxTokens`, because the
 * failure this helper most often meets on a long note is not malformed JSON — it is a generation
 * the engine CUT OFF at its output cap. Re-asking with the same budget and a longer prompt (the
 * corrective text is appended) reproduces the truncation exactly, which is what the live flush
 * was observed doing four times in a row on one consultation.
 */
export interface JsonRepairRetry {
  corrective: string;
  /** Output budget for the retry. `undefined` leaves the caller's own default in place. */
  maxTokens?: number;
}

/**
 * A generation the engine stopped at its output cap.
 *
 * FATAL by construction, and that is the whole point. A truncated structured response parses as
 * nothing and "tolerantly" parses as a half-document that is indistinguishable, downstream, from
 * a note the model genuinely finished — on the reported consultation that half-document was
 * written into a clinical section as if it were its content. Raising it as an error routes it
 * into the caller's existing degrade path instead, where a failed flush keeps the prior note.
 *
 * Carries the calls made so the caller can still record an accurate trajectory for the attempt.
 */
export class TruncatedGenerationError extends Error {
  /**
   * Stable code, in BOTH places a consumer reads one.
   *
   * `message` is the bare code and nothing else, deliberately. The realtime executor stringifies
   * a thrown node error to `error.message` and hands that to `degradeCode`, which passes a bare
   * `^[a-z][a-z0-9_]*$` through unchanged — that is the codebase's existing idiom for "this is
   * already a code, do not classify it". A descriptive sentence here would be classified by
   * regex instead and land on the clinician's feed as the generic fallback. The detail a server
   * log wants lives on `attempts`/`calls`, which is where a structured logger can reach it
   * without it ever reaching a feed.
   */
  readonly code = 'output_truncated';

  constructor(
    readonly calls: readonly JsonRepairCall[],
    readonly attempts: number,
  ) {
    super('output_truncated');
    this.name = 'TruncatedGenerationError';
  }
}

export interface JsonRepairOutcome<T, C extends JsonRepairCall> {
  /**
   * The parsed value: a strict parse of the original (or, on repair, the retry)
   * response when it succeeded, otherwise the tolerant fallback over the last
   * response text.
   */
  value: T;
  /** Whether the one corrective retry actually ran. */
  repaired: boolean;
  /** Every model call made, in order: index 0 = original, index 1 = repair retry (when present). */
  calls: C[];
}

/**
 * Run a JSON-producing generation with a single bounded corrective retry.
 *
 * Flow:
 * 1. `generate(undefined)` → strict-parse. If it parses, return it (no repair).
 * 2. Strict parse failed. If `shouldRepair(firstCall)` is false (e.g. the engine
 *    ignores `response_format`, so retrying can never yield JSON), tolerant-parse
 *    the original and return.
 * 3. Otherwise `generate(corrective)` ONCE → strict-parse the retry; on success
 *    return it (`repaired: true`); else tolerant-parse the retry and return it.
 *
 * The helper NEVER retries more than once and NEVER swallows a thrown model call
 * — transport errors propagate so the caller can apply its own degrade path.
 */
export async function generateJsonWithRepair<T, C extends JsonRepairCall>(params: {
  generate: (retry: JsonRepairRetry | undefined) => Promise<C>;
  parseStrict: (text: string) => T | null;
  /**
   * The degrade parse. Receives the CALL, not just its text, so it can see the engine's own
   * stats — the tolerant path is where a caller decides what a non-strict response means.
   */
  parseTolerant: (call: C) => T;
  shouldRepair: (firstCall: C) => boolean;
  corrective?: string;
  /** Output budget for the one corrective retry. Omit to leave the caller's default. */
  repairMaxTokens?: number;
  /**
   * True when the engine stopped this call at its output cap. Optional: a caller that cannot
   * tell (no stats) keeps the pre-TASK-1000 contract exactly, tolerant parse and all.
   */
  isTruncated?: (call: C) => boolean;
}): Promise<JsonRepairOutcome<T, C>> {
  const corrective = params.corrective ?? CORRECTIVE_RETRY_INSTRUCTION;
  const calls: C[] = [];
  const truncated = (call: C): boolean => params.isTruncated?.(call) === true;

  const first = await params.generate(undefined);
  calls.push(first);
  const firstParsed = params.parseStrict(first.text);
  if (firstParsed !== null) {
    return { value: firstParsed, repaired: false, calls };
  }

  if (!params.shouldRepair(first)) {
    // A truncated response is never degraded, even when it is not eligible for repair: there is
    // no reading of half a document that is safe to show a clinician as the note.
    if (truncated(first)) throw new TruncatedGenerationError(calls, 1);
    return { value: params.parseTolerant(first), repaired: false, calls };
  }

  const second = await params.generate({ corrective, maxTokens: params.repairMaxTokens });
  calls.push(second);
  const secondParsed = params.parseStrict(second.text);
  if (secondParsed !== null) {
    return { value: secondParsed, repaired: true, calls };
  }

  // The retry ran on a RAISED budget (above). Still truncated means the document does not fit
  // any budget this path can offer, so the flush fails and the prior note stands.
  if (truncated(second)) throw new TruncatedGenerationError(calls, 2);

  return { value: params.parseTolerant(second), repaired: true, calls };
}
