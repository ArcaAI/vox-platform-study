import type { FactKind, FactLedgerV1 } from './fact-ledger.schema';

/** Recorded on every ENCOUNTER_RECAP version (`metaData.renderer`). */
export const ENCOUNTER_RECAP_RENDERER = 'recap.v1';

export type RecapSectionKey = 'complaint' | 'key_findings' | 'medications' | 'plan_orders' | 'pending';

export interface EncounterRecapRendering {
  text: string;
  sections: Array<{ key: RecapSectionKey; label: string; text: string }>;
}

const SECTIONS: ReadonlyArray<{ key: RecapSectionKey; label: string; kinds: ReadonlyArray<FactKind> }> = [
  { key: 'complaint', label: 'Complaint', kinds: ['complaint'] },
  {
    key: 'key_findings',
    label: 'Key findings',
    kinds: ['history', 'allergy', 'vital', 'exam', 'result', 'diagnosis', 'red_flag', 'negation', 'other'],
  },
  { key: 'medications', label: 'Medications', kinds: ['medication', 'dose_change'] },
  { key: 'plan_orders', label: 'Plan/Orders', kinds: ['plan', 'order'] },
  { key: 'pending', label: 'Pending', kinds: ['follow_up'] },
];

/**
 * Render an encounter recap from its ledger: the ACTIVE facts, verbatim, each followed by the
 * labels of the lines it cites, under fixed headings. Empty headings are omitted.
 *
 * A pure template — no model call, no I/O, no clock. Display-only: a recap is never a note input.
 */
export function renderEncounterRecap(ledger: FactLedgerV1): EncounterRecapRendering {
  const labels = new Map<string, string>();
  for (const source of ledger.sources) labels.set(source.segmentId, source.label);
  for (const source of ledger.attachmentSources) labels.set(source.itemId, source.label);

  const active = ledger.facts.filter((fact) => !fact.supersededBy);
  const sections: EncounterRecapRendering['sections'] = [];
  for (const section of SECTIONS) {
    const lines = active
      .filter((fact) => section.kinds.includes(fact.kind))
      .map((fact) => `- ${fact.statement}${citationSuffix(fact.citations, labels)}`);
    if (lines.length > 0) sections.push({ key: section.key, label: section.label, text: lines.join('\n') });
  }

  return {
    text: sections.map((section) => `## ${section.label}\n${section.text}`).join('\n\n'),
    sections,
  };
}

function citationSuffix(citations: ReadonlyArray<string>, labels: ReadonlyMap<string, string>): string {
  const rendered = [...new Set(citations.map((id) => labels.get(id)).filter((label): label is string => Boolean(label)))].sort(compareLabels);
  return rendered.length > 0 ? ` [${rendered.join(', ')}]` : '';
}

/** `S` before `A`, then numerically. */
function compareLabels(a: string, b: string): number {
  if (a[0] !== b[0]) return a[0] === 'S' ? -1 : 1;
  return Number(a.slice(1)) - Number(b.slice(1));
}
