/**
 * TASK-1001 (wave 2, final note) — the FINAL note's headed sections, with the cross-section
 * `duplicate` flags computed over its final text.
 *
 * ## Why this exists
 *
 * The live note flags a passage the model filed into two sections (owner decision 2026-09-23: FLAG,
 * never drop — `crossSectionDuplicates` in `turn-contract.ts`). Once the consultation ends, the
 * client shows the FINAL note: the finalizer's narrative (`SummaryResponse.content` of
 * `GET consultations/:id/summary/latest`), split at its headings, whose text outranks the live
 * section it replaces. That note carried no annotations, so a flagged passage lost its flag at the
 * moment the clinician reviews the note. The finalizer's text is not the live text, so the live
 * flags cannot simply be carried over: they are recomputed here, over the final text, by the SAME
 * detector (`crossSectionDuplicateAnnotations`) — never by a second copy of the rule.
 *
 * ## Three rules
 *
 *  - **Located, not copied.** A section is `{ start, end }` into the note; its body is
 *    `content.slice(start, end)`. The note stays the one, unaltered copy of its text, and nothing
 *    here can drop or rewrite a character of it.
 *  - **The client's split.** A heading is a line the reference client (ALaaS `parseFinalizerNote` /
 *    `parseHeadedNote`) also reads as one — `## Title`, `**Title**`, `**Title:**`, at most 80
 *    characters — and a body is the text up to the next heading, whitespace-trimmed. Both sides
 *    therefore see the same sections, so section-local offsets address the same text on both.
 *    Text before the first heading belongs to no section.
 *  - **The consultation's own keys.** `sectionKey` is the key of the consultation's document
 *    section with the same title (case and punctuation aside) — the key
 *    `GET consultations/:id/documents/sections` reports, and the one the live flags name — else a
 *    key derived from the heading (`Family History` → `family_history`).
 */
import type { SectionAnnotationDto } from '../live-documentation/realtime/dto/section-patch.dto';
import { crossSectionDuplicateAnnotations } from '../live-documentation/realtime/turn-contract';
import type { SummaryDuplicateAnnotationDto, SummaryNoteSectionDto } from './dto';

/** A heading line: `## Title`, `**Title**`, `**Title:**` — the reference client's own rule. */
const NOTE_HEADING = /^\s{0,3}(?:#{1,6}\s+|\*\*)(.+?)(?:\*\*)?\s*:?\s*$/;
/** A longer "heading" is a bold sentence, not a section title. */
const MAX_HEADING_LENGTH = 80;
/** Non-global on purpose: a `g` regex carries `lastIndex` between `.test()` calls. */
const WHITESPACE = /\s/;

/** One headed section of a note: its heading, and where its body sits in the note. */
export interface HeadedNoteSpan {
  readonly title: string;
  /** `content.slice(start, end)` is the body, whitespace-trimmed; `start === end` for an empty section. */
  readonly start: number;
  readonly end: number;
}

/** Split a note at its heading lines. `[]` when it has none. */
export function splitHeadedNote(content: string): HeadedNoteSpan[] {
  const headings: Array<{ title: string; lineStart: number; bodyStart: number }> = [];

  let lineStart = 0;
  for (;;) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    // The client splits on `\r?\n`, so a CRLF line's `\r` is not part of the line it tests.
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');
    const title = NOTE_HEADING.exec(line)?.[1]
      ?.trim()
      .replace(/[\s:]+$/, '');
    if (title && title.length <= MAX_HEADING_LENGTH) {
      headings.push({ title, lineStart, bodyStart: newline === -1 ? content.length : newline + 1 });
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return headings.map((heading, index) => {
    let start = heading.bodyStart;
    let end = index + 1 < headings.length ? headings[index + 1]!.lineStart : content.length;
    while (start < end && WHITESPACE.test(content[start]!)) start += 1;
    while (end > start && WHITESPACE.test(content[end - 1]!)) end -= 1;
    return { title: heading.title, start, end };
  });
}

/** The comparison form of a title: case, spacing and punctuation carry no identity. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A key for a heading no document section of the consultation carries. */
function derivedSectionKey(title: string, index: number): string {
  const key = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return key || `section_${index + 1}`;
}

/**
 * Title → `sectionKey`, from the consultation's document sections, for {@link finalNoteSections}.
 * The FIRST row wins when two share a title (rows arrive in `(documentKey, idx)` order).
 */
export function sectionKeysByTitle(rows: Iterable<{ readonly sectionKey: string; readonly title: string }>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const row of rows) {
    const key = titleKey(row.title);
    if (key && !keys.has(key)) keys.set(key, row.sectionKey);
  }
  return keys;
}

function toFinalAnnotation(annotation: SectionAnnotationDto): SummaryDuplicateAnnotationDto {
  return {
    kind: 'duplicate',
    start: annotation.start,
    end: annotation.end,
    duplicateOf: annotation.duplicateOf!,
    ...(annotation.duplicateOfTitle ? { duplicateOfTitle: annotation.duplicateOfTitle } : {}),
  };
}

/**
 * The note's headed sections, each carrying the cross-section `duplicate` flags of its FINAL text
 * (section-local, on the later copy; `annotations` absent when nothing is flagged).
 *
 * `undefined` when the note has fewer than two headed sections — there is nothing to compare across,
 * and "no sections" is then the honest answer rather than one section wrapping the whole note.
 */
export function finalNoteSections(content: string, keysByTitle: ReadonlyMap<string, string> = new Map()): SummaryNoteSectionDto[] | undefined {
  const spans = splitHeadedNote(content);
  if (spans.length < 2) return undefined;

  const sections = spans.map((span, index) => ({
    ...span,
    sectionKey: keysByTitle.get(titleKey(span.title)) ?? derivedSectionKey(span.title, index),
  }));
  const flags = crossSectionDuplicateAnnotations(
    sections.map((section) => ({ sectionKey: section.sectionKey, title: section.title, content: content.slice(section.start, section.end) })),
  );

  return sections.map((section, index) => {
    const annotations = flags[index]!.map(toFinalAnnotation);
    return {
      sectionKey: section.sectionKey,
      title: section.title,
      start: section.start,
      end: section.end,
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  });
}
