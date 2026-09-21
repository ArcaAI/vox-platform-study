/**
 * Paragraph grouping for `LiveTranscript` (TASK-998).
 *
 * `useLiveTranscript`'s `displaySegments` memo already folds code-switching
 * glosses into their final segment by `utteranceIndex` — one row per VAD/ASR
 * utterance otherwise. That reads as disjointed chunks: a continuous run of
 * speech from one speaker gets a fresh header + block per utterance boundary,
 * with no visual relationship between them. This module groups ADJACENT
 * segments that are almost certainly one continuous run into a single
 * "paragraph" for rendering — it never mutates or drops a segment, it only
 * describes how consecutive ones should be presented together.
 *
 * Deliberately independent of the sibling heuristic in
 * `packages/applications/src/services/consultation/summary/transcript-assembly.util.ts`
 * — the two packages share no runtime dependency, and the inputs differ (this
 * one has real `startTime`/`endTime` on in-memory `LiveTranscriptSegment`s;
 * that one only has a persisted row's `createdAt`) — but the seam rule (single
 * space; never double a terminal `.`/`!`/`?`) is the same idea applied twice
 * because the two layers cannot literally share code.
 */
import type { LiveTranscriptSegment } from './types';

/** A group of adjacent segments to render as one flowing paragraph. */
export interface TranscriptParagraph {
  /** Stable virtualization key — the lead (first) member's id. */
  id: string;
  /** Member segments, in chronological order. `segments[0]` is the lead. */
  segments: LiveTranscriptSegment[];
  /** The trailing member's finality — a partial tail keeps the paragraph "live". */
  isFinal: boolean;
  /** Assembled text across all members (seam-joined) — for tests/aria, not pixel rendering. */
  text: string;
  /** Assembled code-switching gloss across members carrying one, if any. */
  englishText?: string;
}

export interface GroupTranscriptSegmentsOptions {
  /**
   * Seconds of silence between two segments' `endTime`/`startTime` beyond
   * which they start a new paragraph even for the same speaker. Default: 2s.
   *
   * Chosen from the shape of natural speech rather than any one STT vendor's
   * endpointing config (this is a presentation heuristic, not a pipeline
   * setting): a breath or word-finding pause inside one continuous utterance
   * run is well under a second; a real turn change or topical pause in a
   * clinical conversation reads as noticeably longer. 2s sits between the
   * two, so it glues a speaker's own continuation together without
   * accidentally merging across an actual pause.
   */
  gapSeconds?: number;
  /**
   * When `false`, every segment becomes its own single-member paragraph
   * (used by `useLiveTranscript` while `editable` is true — see the callers'
   * comment for why editing stays out of scope for merged paragraphs).
   */
  enabled?: boolean;
}

export const DEFAULT_PARAGRAPH_GAP_SECONDS = 2;

/** A cap on how large one visual paragraph is allowed to grow, independent of
 *  gap/speaker — an unbroken 5-minute monologue should still read as more
 *  than one block. */
const MAX_PARAGRAPH_SPAN_SECONDS = 45;
const MAX_PARAGRAPH_MEMBERS = 12;

function endsWithTerminalPunctuation(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text);
}

/**
 * Join two text fragments with a single normalized space, never a doubled
 * terminator at the seam. Exported standalone so the seam rule is directly
 * unit-testable without going through the grouping pass. Also used by the
 * paragraph renderer (`transcript-paragraph.tsx`) so the on-screen seam
 * always matches what this produces.
 */
export function joinTranscriptFragments(previous: string, next: string): string {
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
 * How many leading characters of `next` are a duplicate seam artifact (a
 * stray terminator repeating one `previous` already ends with) and whether a
 * joining space belongs between them. Lets the renderer reproduce the exact
 * same seam as `joinTranscriptFragments` while still slicing/measuring the
 * ORIGINAL member text (needed to keep `stableChars` offsets meaningful).
 */
export function seamAdjustment(previous: string, next: string): { separator: string; skip: number } {
  const trimmedPrevious = previous.replace(/\s+$/, '');
  const leadingWhitespace = next.match(/^\s*/)?.[0].length ?? 0;
  const rest = next.slice(leadingWhitespace);
  let skip = leadingWhitespace;
  if (trimmedPrevious && endsWithTerminalPunctuation(trimmedPrevious)) {
    const dup = rest.match(/^[.!?…]+\s*/);
    if (dup) skip += dup[0].length;
  }
  const separator = trimmedPrevious.length > 0 && skip < next.length ? ' ' : '';
  return { separator, skip };
}

function canGroupWithPrevious(paragraph: TranscriptParagraph, segment: LiveTranscriptSegment, gapSeconds: number): boolean {
  const previous = paragraph.segments[paragraph.segments.length - 1];
  // A non-final tail is always the live edge of the stream — nothing is ever
  // appended after a partial (a fresh final REPLACES it with a new id).
  if (!previous.isFinal) return false;
  // Same speaker only. `undefined === undefined` counts as "same speaker" —
  // most transcripts carry no diarization at all, and that must never itself
  // force a paragraph break, or every undiarized transcript renders back to
  // one paragraph per utterance.
  if ((previous.speakerLabel ?? null) !== (segment.speakerLabel ?? null)) return false;
  if (paragraph.segments.length >= MAX_PARAGRAPH_MEMBERS) return false;
  // Require positive evidence of adjacency: without both timestamps we
  // cannot tell "the next utterance" from "an unrelated one much later", so
  // we conservatively keep them separate rather than guess.
  if (previous.endTime == null || segment.startTime == null) return false;
  const gap = segment.startTime - previous.endTime;
  if (gap < 0) return false; // out-of-order/overlapping — don't guess
  if (gap > gapSeconds) return false;
  const leadStart = paragraph.segments[0].startTime;
  const nextEnd = segment.endTime ?? segment.startTime;
  if (leadStart != null && nextEnd - leadStart > MAX_PARAGRAPH_SPAN_SECONDS) return false;
  return true;
}

/**
 * Group adjacent segments (already gloss-folded — see `useLiveTranscript`'s
 * `displaySegments`) into paragraphs. Order-preserving; never drops a
 * segment.
 */
export function groupTranscriptSegments(segments: LiveTranscriptSegment[], options: GroupTranscriptSegmentsOptions = {}): TranscriptParagraph[] {
  const gapSeconds = options.gapSeconds ?? DEFAULT_PARAGRAPH_GAP_SECONDS;
  const enabled = options.enabled ?? true;
  const paragraphs: TranscriptParagraph[] = [];

  for (const segment of segments) {
    const current = paragraphs[paragraphs.length - 1];
    if (enabled && current && canGroupWithPrevious(current, segment, gapSeconds)) {
      current.segments.push(segment);
      current.isFinal = segment.isFinal;
      current.text = joinTranscriptFragments(current.text, segment.text);
      if (segment.englishText) {
        current.englishText = current.englishText ? joinTranscriptFragments(current.englishText, segment.englishText) : segment.englishText;
      }
    } else {
      paragraphs.push({
        id: segment.id,
        segments: [segment],
        isFinal: segment.isFinal,
        text: segment.text,
        englishText: segment.englishText,
      });
    }
  }

  return paragraphs;
}
