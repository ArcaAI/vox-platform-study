/**
 * filling the case note from the live SOAP stream.
 *
 * `LiveSummarySnapshot.sections` already carries the four SOAP sections (the server parses
 * them in `live-documentation/soap-parser.ts`, whose `LIVE_SOAP_RESPONSE_FORMAT` pins
 * subjective/objective/assessment/plan). This module turns them into the SOAP-labelled prose
 * the note actually stores, so an autofill populates the SECTIONS rather than dumping
 * `runningSummary` as an undifferentiated blob.
 *
 * `composeAutofill` holds the rule that matters: an autofill NEVER replaces text the
 * clinician has typed. An empty buffer is filled; a buffer with content is APPENDED to. That
 * keeps the R5 property intact by construction — there is no code path here that can destroy
 * clinician text, so the two-writer contract in `use-note-editor.ts` never has to arbitrate
 * one.
 */

/** The section shape carried by `LiveSummarySnapshot.sections`. */
export interface SoapSection {
  title: string;
  content: string;
}

/** Canonical order, matching `SOAP_SECTION_TITLES` in the server's parser. */
const SOAP_ORDER = ['subjective', 'objective', 'assessment', 'plan'];

function rank(title: string): number {
  const index = SOAP_ORDER.indexOf(title.trim().toLowerCase());
  // Unknown sections (e.g. "Running Summary") sort after the four rather than being dropped.
  return index === -1 ? SOAP_ORDER.length : index;
}

/** SOAP-labelled prose, canonically ordered, empty sections omitted. */
export function formatSoapSections(sections: readonly SoapSection[]): string {
  return [...sections]
    .filter((section) => section.content.trim().length > 0)
    .sort((left, right) => rank(left.title) - rank(right.title))
    .map((section) => `${section.title.trim()}:\n${section.content.trim()}`)
    .join('\n\n');
}

/**
 * Merge an autofill block into the clinician's current buffer.
 *
 * Empty (or whitespace-only) buffer → filled. Buffer with content → APPENDED, separated by a
 * blank line. Never a replacement: losing typed clinical text is the one outcome that is
 * never acceptable.
 */
export function composeAutofill(buffer: string, block: string): string {
  if (block.trim().length === 0) return buffer;
  if (buffer.trim().length === 0) return block;
  return `${buffer}\n\n${block}`;
}
