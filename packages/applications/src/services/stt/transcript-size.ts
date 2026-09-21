/**
 * TASK-999 (D-3(a)) — the ONE definition of "how big is this transcript".
 *
 * `TranscriptionJob.encryptedResultText` and `ContextItem.encryptedContent` are
 * Vault-Transit ciphertext, so an admin read cannot measure them without
 * decrypting PHI to produce a number. The WRITER measures once instead — which
 * only works if every writer agrees on what a word is.
 *
 * The word rule is the one that was already in use at the single existing count
 * site (the `TranscriptionCreated` pipeline event): split on whitespace, drop
 * empties. Extracted rather than re-typed, so the counter on the row and the
 * counter on the event can never drift into two different numbers.
 */
export interface TranscriptSize {
  wordCount: number;
  charCount: number;
}

/** Words in `text` — whitespace-separated, empties dropped. */
export function countTranscriptWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Measure a transcript. `null`/`undefined` returns `null` — "never measured" —
 * because an absent transcript and an empty one are different facts, and `0` is
 * reserved for a real empty transcript.
 */
export function measureTranscript(text: string | null | undefined): TranscriptSize | null {
  if (typeof text !== 'string') return null;
  return { wordCount: countTranscriptWords(text), charCount: text.length };
}
