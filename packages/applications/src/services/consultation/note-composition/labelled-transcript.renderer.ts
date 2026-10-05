/**
 * The labels every note input line carries, so a statement in the note can cite its source and
 * the coverage check can resolve the citation back to an item version.
 *
 *   transcript line  `[S<segmentSeq> E<encounterSeq> <Speaker> mm:ss] <text>`
 *   result           `[R<n>] <text>`
 *   uploaded audio   `[A<n>] <text>`
 *   ledger fact      `<factId> <kind>: <statement> [S12, A1]`
 *
 * `mm:ss` is the segment's start on the consultation's recording timeline. Text is folded onto one
 * line so a label always starts a line.
 */

export interface LabelledSegment {
  segmentSeq: number;
  encounterSeq: number;
  speaker?: string | null;
  t0Ms?: number | null;
  text: string;
}

export function segmentLabel(segmentSeq: number): string {
  return `S${segmentSeq}`;
}

export function resultLabel(index: number): string {
  return `R${index + 1}`;
}

export function attachmentTranscriptLabel(index: number): string {
  return `A${index + 1}`;
}

export function mmss(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function speakerLabel(raw: string | null | undefined): string {
  const speaker = raw?.trim();
  if (!speaker) return 'Unknown';
  return speaker.charAt(0).toUpperCase() + speaker.slice(1);
}

export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

export function renderSegmentLine(segment: LabelledSegment): string {
  return `[${segmentLabel(segment.segmentSeq)} E${segment.encounterSeq} ${speakerLabel(segment.speaker)} ${mmss(segment.t0Ms)}] ${oneLine(segment.text)}`;
}

export function renderLabelledLine(label: string, text: string): string {
  return `[${label}] ${oneLine(text)}`;
}

export interface RenderableFact {
  factId: string;
  kind: string;
  statement: string;
  supersededBy?: string | null;
}

/** A ledger fact as the note model sees it; superseded facts stay visible and say so. */
export function renderLedgerFact(fact: RenderableFact, citationLabels: readonly string[], supersededBy: string | null): string {
  const cited = citationLabels.length > 0 ? ` [${citationLabels.join(', ')}]` : '';
  const superseded = supersededBy ? ` (superseded by ${supersededBy})` : '';
  return `${fact.factId} ${fact.kind}: ${oneLine(fact.statement)}${cited}${superseded}`;
}
