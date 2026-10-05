import type { FactKind, FactLedgerV1, LedgerFact } from './fact-ledger.schema';
import { normaliseFactKind } from './fact-ledger-normalise';

/** Recorded on every ENCOUNTER_RECAP version (`metaData.renderer`). */
export const ENCOUNTER_RECAP_RENDERER = 'recap.v2';

/** The `schema` of the stored recap body (and `metaData.schema`). */
export const ENCOUNTER_RECAP_SCHEMA = 'hope.encounter_recap.v2';

export type RecapSectionKey = 'reason' | 'findings' | 'medicines' | 'sent_for' | 'since_then' | 'still_open';

export interface RecapCitation {
  itemId: string;
  versionNumber: number;
  /** What the extractor saw: `S<segmentSeq>` or `A<n>`. */
  label: string;
  kind: 'segment' | 'attachment';
  /** Recording-timeline start of a cited segment. */
  t0Ms?: number;
}

export interface RecapLine {
  /** One active fact statement, verbatim. */
  text: string;
  citations: RecapCitation[];
}

export interface RecapSection {
  key: RecapSectionKey;
  label: string;
  lines: RecapLine[];
}

/** The stored ENCOUNTER_RECAP body. Consumers map sections by `key`, never by position. */
export interface EncounterRecapV2 {
  schema: typeof ENCOUNTER_RECAP_SCHEMA;
  sections: RecapSection[];
}

/**
 * The six fixed sections, in order. Lines keep transcript order, except that the working
 * impression (`diagnosis`) is placed after the vitals, exam and results it rests on. `since_then` takes no kinds: it holds any
 * fact cited only by uploaded transcripts that arrived after the encounter ended, whatever its
 * kind. Kinds listed nowhere (negation, other) are not part of the recap.
 */
const SECTIONS: ReadonlyArray<{ key: RecapSectionKey; label: string; kinds: ReadonlyArray<FactKind> }> = [
  { key: 'reason', label: 'Reason', kinds: ['complaint', 'history'] },
  { key: 'findings', label: 'Findings', kinds: ['vital', 'exam', 'result', 'diagnosis'] },
  { key: 'medicines', label: 'Medicines', kinds: ['medication', 'dose_change', 'allergy'] },
  { key: 'sent_for', label: 'Sent for', kinds: ['order'] },
  { key: 'since_then', label: 'Since then', kinds: [] },
  { key: 'still_open', label: 'Still open', kinds: ['plan', 'follow_up', 'red_flag'] },
];

/**
 * Render an encounter recap from its ledger: each ACTIVE fact, verbatim, with the items it cites,
 * under the six fixed sections (empty ones kept with `lines: []`).
 *
 * A pure template — no model call, no I/O, no clock. Display-only: a recap is never a note input.
 */
export function renderEncounterRecap(ledger: FactLedgerV1): EncounterRecapV2 {
  const citationsById = new Map<string, RecapCitation>();
  const late = new Set<string>();
  for (const source of ledger.sources) {
    citationsById.set(source.segmentId, {
      itemId: source.segmentId,
      versionNumber: source.versionNumber,
      label: source.label,
      kind: 'segment',
      ...(typeof source.t0Ms === 'number' ? { t0Ms: source.t0Ms } : {}),
    });
  }
  for (const source of ledger.attachmentSources) {
    citationsById.set(source.itemId, { itemId: source.itemId, versionNumber: source.versionNumber, label: source.label, kind: 'attachment' });
    if (source.arrivedAfterEncounterEnd) late.add(source.itemId);
  }

  const sections: RecapSection[] = SECTIONS.map((section) => ({ key: section.key, label: section.label, lines: [] }));
  const byKey = new Map(sections.map((section) => [section.key, section]));

  for (const fact of [...ledger.facts].sort(byKindGroup)) {
    if (fact.supersededBy) continue;
    const key = sectionFor(fact, late);
    if (!key) continue;
    const citations = fact.citations
      .map((id) => citationsById.get(id))
      .filter((citation): citation is RecapCitation => Boolean(citation))
      .sort(compareCitations);
    byKey.get(key)!.lines.push({ text: fact.statement, citations });
  }

  return { schema: ENCOUNTER_RECAP_SCHEMA, sections };
}

/** The derived plain text for the console: one `## Label` block per section, in order. */
export function renderRecapText(recap: EncounterRecapV2): string {
  return recap.sections
    .map((section) => {
      const lines = section.lines.length > 0 ? section.lines.map(lineText) : ['- None'];
      return [`## ${section.label}`, ...lines].join('\n');
    })
    .join('\n\n');
}

function lineText(line: RecapLine): string {
  const labels = [...new Set(line.citations.map((citation) => citation.label))];
  return `- ${line.text}${labels.length > 0 ? ` [${labels.join(', ')}]` : ''}`;
}

/** Only `diagnosis` trails its section's other kinds; every other fact keeps transcript order. */
function byKindGroup(a: LedgerFact, b: LedgerFact): number {
  const isDiagnosis = (fact: LedgerFact) => normaliseFactKind(fact.key, fact.kind) === 'diagnosis';
  return Number(isDiagnosis(a)) - Number(isDiagnosis(b));
}

function sectionFor(fact: LedgerFact, late: ReadonlySet<string>): RecapSectionKey | null {
  if (fact.citations.length > 0 && fact.citations.every((id) => late.has(id))) return 'since_then';
  // The kind as the key's prefix names it: a ledger stored before the extractor's drift was
  // repaired (`medication:metformin` with kind `history`) still renders under the right heading.
  const kind = normaliseFactKind(fact.key, fact.kind);
  return SECTIONS.find((section) => section.kinds.includes(kind))?.key ?? null;
}

/** Segments before attachments, then numerically by label. */
function compareCitations(a: RecapCitation, b: RecapCitation): number {
  if (a.kind !== b.kind) return a.kind === 'segment' ? -1 : 1;
  return Number(a.label.slice(1)) - Number(b.label.slice(1));
}
