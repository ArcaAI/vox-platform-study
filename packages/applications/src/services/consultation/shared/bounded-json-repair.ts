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
 */
export const CORRECTIVE_RETRY_INSTRUCTION = `\n\nREVISE STRICTLY:
- Do NOT use placeholders like 'Not documented' or 'Summary not available' (or their equivalents in the conversation language).
- Monolingual rule: All headings/labels and descriptive content inside values MUST be in the conversation language. Do NOT include any English words inside values.
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
  generate: (corrective: string | undefined) => Promise<C>;
  parseStrict: (text: string) => T | null;
  parseTolerant: (text: string) => T;
  shouldRepair: (firstCall: C) => boolean;
  corrective?: string;
}): Promise<JsonRepairOutcome<T, C>> {
  const corrective = params.corrective ?? CORRECTIVE_RETRY_INSTRUCTION;
  const calls: C[] = [];

  const first = await params.generate(undefined);
  calls.push(first);
  const firstParsed = params.parseStrict(first.text);
  if (firstParsed !== null) {
    return { value: firstParsed, repaired: false, calls };
  }

  if (!params.shouldRepair(first)) {
    return { value: params.parseTolerant(first.text), repaired: false, calls };
  }

  const second = await params.generate(corrective);
  calls.push(second);
  const secondParsed = params.parseStrict(second.text);
  return {
    value: secondParsed ?? params.parseTolerant(second.text),
    repaired: true,
    calls,
  };
}
