/** TASK-1059 C-13 — a specific message for the failures the live test hits, instead of "internal error". */

const CONTEXT_WINDOW_PATTERN = /CONTEXT_WINDOW_EXCEEDED|kv[_ ]?exhaust|context (window|length)|KV cache/i;

/** `null` = nothing specific to say; the caller keeps its own text. */
export function contextWindowCopy(...sources: Array<string | null | undefined>): string | null {
  return sources.some((source) => source && CONTEXT_WINDOW_PATTERN.test(source))
    ? 'The model ran out of context window (KV cache). Shorten the input or the context, or choose a model with a larger context window, then run the test again.'
    : null;
}
