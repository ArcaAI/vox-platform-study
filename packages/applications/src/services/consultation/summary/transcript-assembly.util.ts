/**
 * Transcript-fragment assembly (TASK-998).
 *
 * `TranscriptSegmentRepository`/`ContextItemRepository.findTranscripts` return
 * one row per STT UTTERANCE — `useArcaAudio.ts` POSTs one `ContextItem` per
 * finalized utterance (owner decision OD-3: assembly is PER-CONSUMER, never
 * centralized upstream in the STT service or the write path). Every reader of
 * those rows used to do `items.map((c) => c.content).join('\n\n')`, which hands
 * the LLM (and, in `chain-summary.service.ts`, a fresh "--- Section N ---"
 * header) one paragraph per utterance — a 30-second answer fragments into a
 * dozen one-sentence "paragraphs" with no relationship to how the sentence
 * actually reads.
 *
 * This module is this consumer's assembly step: group adjacent fragments that
 * are almost certainly one continuous utterance-run into a single paragraph,
 * and join their text with a normalized single-space seam instead of a bare
 * concatenation. It is deliberately independent of the sibling heuristic in
 * `packages/ui/src/components/live-transcript/paragraph-grouping.ts` — the two
 * packages do not share a runtime dependency, and the inputs differ (that one
 * groups in-memory `LiveTranscriptSegment`s with real `startTime`/`endTime`;
 * this one groups persisted `ContextItem` rows whose only universal timing
 * signal is `createdAt`, the server-received wall-clock time) — but the seam
 * rule (single space; never double a terminal `.`/`!`/`?`) is the same idea
 * applied twice because the two layers cannot literally share code.
 *
 * Lossless by construction: every fragment's text either lands in some
 * paragraph's `content` or was empty (whitespace-only) to begin with — nothing
 * is ever summarized, truncated, or discarded once it clears the input filter.
 */

/** One row to assemble — a subset of `ContextItemEntity` shaped for this module alone. */
export interface AssemblableTranscriptFragment {
  content: string | null | undefined;
  /** `ContextItemEntity.createdAt` — always set on a persisted row. */
  createdAt?: Date | null;
  /** `ContextItemEntity.metaData.speakerId`, when the writer attached one (see `readSpeakerId`). */
  speakerId?: string | null;
}

/** One assembled paragraph — ready to become a `ChainSectionDto` or a joined transcript string. */
export interface AssembledTranscriptParagraph {
  content: string;
  /** The first member fragment's `createdAt` (mirrors "lead segment" on the UI side). */
  createdAt?: Date;
}

export interface AssembleTranscriptFragmentsOptions {
  /**
   * Seconds between two fragments' `createdAt` beyond which they are treated
   * as separate paragraphs even with no speaker signal. Default: 8s.
   *
   * `createdAt` is server-received wall-clock time, not the STT-side
   * utterance boundary — it carries request/network latency and event-loop
   * jitter on top of whatever pause actually happened between utterances. 8s
   * is comfortably above that jitter (POSTs land within a second or two of
   * finalization in practice) while staying well under the scale of a real
   * conversational pause or a reconnect, so it separates genuine gaps without
   * being tripped by assembly noise.
   */
  gapSeconds?: number;
}

export const DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS = 8;

function endsWithTerminalPunctuation(text: string): boolean {
  // A terminator optionally followed by one closing quote/paren/bracket —
  // "Is that right?"" and "(as noted.)" both count as sentence-final.
  return /[.!?…]["')\]]?$/.test(text);
}

/**
 * Join two text fragments with a single normalized space, never a doubled
 * terminator at the seam (e.g. previous "...right?" + next ". Yes" must never
 * render "...right?. Yes" — the stray leading terminator on `next` is
 * dropped). Exported standalone so the seam rule itself is directly
 * unit-testable without going through the grouping pass.
 */
export function joinTranscriptFragmentText(previous: string, next: string): string {
  const trimmedPrevious = previous.replace(/\s+$/, '');
  let rest = next.replace(/^\s+/, '');
  if (!trimmedPrevious) return rest;
  if (endsWithTerminalPunctuation(trimmedPrevious)) {
    rest = rest.replace(/^[.!?…]+\s*/, '');
  }
  if (!rest) return trimmedPrevious;
  return `${trimmedPrevious} ${rest}`;
}

/**
 * Read the diarization speaker id a writer may have attached to a
 * `ContextItem` (`useArcaAudio.ts` stores it at `metadata.speakerId`).
 * Historically absent for most rows — callers must treat `undefined` as "no
 * opinion", never as a value that differs from another `undefined`.
 */
export function readSpeakerId(item: { metaData?: Record<string, unknown> | null }): string | undefined {
  const value = item.metaData?.speakerId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRealBoundary(previous: AssemblableTranscriptFragment, next: AssemblableTranscriptFragment, gapSeconds: number): boolean {
  // A speaker change is a real boundary whenever BOTH sides name a speaker
  // and they disagree. Most rows carry no speaker id at all (no diarization
  // attached at write time) — that must never itself force a break, or every
  // undiarized transcript would render as one paragraph per utterance again.
  if (previous.speakerId != null && next.speakerId != null && previous.speakerId !== next.speakerId) {
    return true;
  }
  if (previous.createdAt && next.createdAt) {
    const gapMs = next.createdAt.getTime() - previous.createdAt.getTime();
    // Out-of-order timestamps carry no reliable gap signal — keep the run
    // together rather than guess at a boundary from bad data.
    if (gapMs < 0) return false;
    if (gapMs / 1000 > gapSeconds) return true;
  }
  return false;
}

/**
 * Group adjacent transcript fragments into paragraphs and assemble each
 * paragraph's text with the seam-aware joiner above. Order-preserving —
 * `fragments` must already be in chronological order (as
 * `ContextItemRepository.findTranscripts`/`findByConsultation` return them,
 * sorted `createdAt: 'asc'`).
 */
export function assembleTranscriptFragments(
  fragments: AssemblableTranscriptFragment[],
  options: AssembleTranscriptFragmentsOptions = {},
): AssembledTranscriptParagraph[] {
  const gapSeconds = options.gapSeconds ?? DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS;
  const paragraphs: AssembledTranscriptParagraph[] = [];
  let previous: AssemblableTranscriptFragment | null = null;

  for (const fragment of fragments) {
    const text = (fragment.content ?? '').trim();
    // An empty fragment carries no text to lose — dropping it here is not a
    // loss, it just stops it from leaving a spurious blank seam behind.
    if (!text) continue;

    const current = paragraphs[paragraphs.length - 1];
    if (current && previous && !isRealBoundary(previous, fragment, gapSeconds)) {
      current.content = joinTranscriptFragmentText(current.content, text);
    } else {
      paragraphs.push({ content: text, createdAt: fragment.createdAt ?? undefined });
    }
    previous = fragment;
  }

  return paragraphs;
}

/**
 * Convenience for the common "give me one assembled string" call shape
 * (`summary.service.ts`'s plain-text transcript path) — paragraphs joined
 * with a blank line, exactly like the old `.map(c => c.content).join('\n\n')`
 * except the paragraphs are now real ones instead of one per utterance.
 */
export function assembleTranscriptText(fragments: AssemblableTranscriptFragment[], options: AssembleTranscriptFragmentsOptions = {}): string {
  return assembleTranscriptFragments(fragments, options)
    .map((paragraph) => paragraph.content)
    .join('\n\n');
}
