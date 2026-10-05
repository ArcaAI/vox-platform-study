import { RECAP_SECTION_KEYS, type RecapCitation, type RecapLine, type RecapSectionKey } from '@arcaai/types';

export const RECAP_SCHEMA = 'hope.encounter_recap.v2';

/** Fallback labels for a section whose payload carries none. */
export const RECAP_DEFAULT_LABELS: Record<RecapSectionKey, string> = {
  reason: 'Reason',
  findings: 'Findings',
  medicines: 'Medicines',
  sent_for: 'Sent for',
  since_then: 'Since then',
  still_open: 'Still open',
};

export interface RecapSectionView {
  key: RecapSectionKey;
  label: string;
  lines: RecapLine[];
}

function isCitation(value: unknown): value is RecapCitation {
  const c = value as RecapCitation | null;
  return !!c && typeof c.itemId === 'string' && typeof c.label === 'string' && typeof c.versionNumber === 'number';
}

/**
 * The structured recap content as the six fixed sections, always in key order. Sections map by
 * `key`, never by position; an absent one is kept with no lines. Returns null for any content that
 * is not a v2 recap payload.
 */
export function parseRecap(content: string | null | undefined): RecapSectionView[] | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const payload = parsed as { schema?: unknown; sections?: unknown } | null;
  if (!payload || payload.schema !== RECAP_SCHEMA || !Array.isArray(payload.sections)) return null;
  const byKey = new Map<string, { label?: unknown; lines?: unknown }>();
  for (const section of payload.sections as Array<{ key?: unknown; label?: unknown; lines?: unknown }>) {
    if (typeof section?.key === 'string') byKey.set(section.key, section);
  }
  return RECAP_SECTION_KEYS.map((key) => {
    const section = byKey.get(key);
    const lines = Array.isArray(section?.lines) ? (section.lines as Array<{ text?: unknown; citations?: unknown }>) : [];
    return {
      key,
      label: typeof section?.label === 'string' && section.label ? section.label : RECAP_DEFAULT_LABELS[key],
      lines: lines
        .filter((line) => typeof line?.text === 'string')
        .map((line) => ({ text: line.text as string, citations: Array.isArray(line.citations) ? (line.citations as unknown[]).filter(isCitation) : [] })),
    };
  });
}

/** Plain-text rendering for the timeline row preview. */
export function recapPlainText(sections: RecapSectionView[]): string {
  return sections
    .filter((section) => section.lines.length > 0)
    .map((section) => `${section.label}: ${section.lines.map((line) => line.text).join('; ')}`)
    .join('\n');
}
