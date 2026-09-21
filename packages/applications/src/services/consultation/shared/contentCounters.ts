/**
 * Plaintext size counters for `ContextItem.content` (TASK-999, D-3(a)).
 *
 * ============================================================================
 * WHY THE WRITER COUNTS
 * ============================================================================
 * A context item's clinical body lives only as Vault-Transit ciphertext, so nothing downstream
 * can measure it without a decrypt. The consultation telemetry pane needs case-note and
 * transcript VOLUME on an ADMIN read, and decrypting every item per view would push PHI through
 * a reporting path to produce two integers. So the writer — which is already holding the
 * plaintext, on its way into `encryptContentIntoEntity` — counts it once.
 *
 * NULL means NEVER MEASURED (every row written before this ticket, and every media item that
 * carries no body at all). `0` is a real empty body. Nothing back-fills; a pre-existing row
 * stays NULL until it is next written.
 *
 * `countWords` is the spelling the rest of this codebase already uses for a transcript word
 * count (`sttInternal.service.ts`, `prompt-management.service.ts`): whitespace-separated,
 * empties dropped. Copied rather than invented so two word counts of the same transcript can
 * never disagree. `countCharacters` iterates CODE POINTS (the spread, not `.length`), matching
 * `summary.service.ts`'s own `[...content].length` — a UTF-16 length would over-count Malayalam
 * and every emoji a clinician pastes.
 */

export interface ContentCounters {
  contentWordCount: number;
  contentCharCount: number;
}

export function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

export function countCharacters(content: string): number {
  return [...content].length;
}

/**
 * The two counters for `content`, or `null` when there is nothing to measure.
 *
 * `null` for an absent body (a media item) so the columns stay NULL — "never measured" — rather
 * than claiming a measured zero. An EMPTY STRING is a measured zero and returns `{0, 0}`.
 */
export function contentCounters(content: string | null | undefined): ContentCounters | null {
  if (typeof content !== 'string') return null;
  return { contentWordCount: countWords(content), contentCharCount: countCharacters(content) };
}

/** The minimal entity surface these counters are written onto. */
interface CountableContentEntity {
  contentWordCount?: number | null;
  contentCharCount?: number | null;
}

/**
 * Stamp the counters for `content` onto an entity, immediately before it is encrypted.
 *
 * Call it at every site that writes a body — CREATE and UPDATE alike. An update that rewrites
 * `content` and leaves the counters behind is worse than no counter at all: the pane would
 * render a confident number for text that is no longer there.
 */
export function stampContentCounters(entity: CountableContentEntity, content: string | null | undefined): void {
  const counters = contentCounters(content);
  if (!counters) return;
  entity.contentWordCount = counters.contentWordCount;
  entity.contentCharCount = counters.contentCharCount;
}
