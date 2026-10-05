import { splitHeadedNote } from '../summary/final-note-sections';
import type { NoteHeading } from './note-plan.types';

/**
 * Split the consultation's latest note into what the clinician changed and what is still the AI's
 * draft, heading by heading.
 *
 * A section whose text differs from the latest AI version is clinician-verified content the next
 * note must keep the meaning of; a section identical to it is an AI draft to re-verify against the
 * transcript, never a source on its own. With no AI baseline to compare against, every section is
 * treated as the clinician's — mistaking an edit for a draft could drop what a clinician wrote.
 * A section the clinician deleted is reported as removed rather than silently disappearing.
 *
 * Sections are cut with the reference client's own heading rule (`splitHeadedNote`); a note with no
 * headings is one section keyed `note`.
 */

export interface DraftSection {
  key: string;
  title: string;
  text: string;
  removed: boolean;
}

export interface DraftSplit {
  clinician: DraftSection[];
  ai: DraftSection[];
  clinicianSections: string[];
  aiSections: string[];
}

const WHOLE_NOTE_KEY = 'note';

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function derivedKey(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || WHOLE_NOTE_KEY
  );
}

/** `key → {title, text}` in note order, keyed by the template heading with the same title. */
export function noteSections(content: string, headings: readonly NoteHeading[]): Map<string, { title: string; text: string }> {
  const byTitle = new Map(headings.map((heading) => [titleKey(heading.title), heading]));
  const sections = new Map<string, { title: string; text: string }>();
  const spans = splitHeadedNote(content);
  if (spans.length === 0) {
    const text = content.trim();
    if (text) sections.set(WHOLE_NOTE_KEY, { title: 'Note', text });
    return sections;
  }
  for (const span of spans) {
    const heading = byTitle.get(titleKey(span.title));
    const key = heading?.key ?? derivedKey(span.title);
    const text = content.slice(span.start, span.end).trim();
    const previous = sections.get(key);
    sections.set(key, { title: heading?.title ?? span.title, text: previous ? `${previous.text}\n${text}`.trim() : text });
  }
  return sections;
}

function normalised(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function splitDraft(latest: string, aiBaseline: string | null, headings: readonly NoteHeading[]): DraftSplit {
  const current = noteSections(latest, headings);
  const baseline = aiBaseline === null ? null : noteSections(aiBaseline, headings);
  const order = [...headings.map((heading) => heading.key), ...current.keys(), ...(baseline?.keys() ?? [])];
  const seen = new Set<string>();
  const clinician: DraftSection[] = [];
  const ai: DraftSection[] = [];

  for (const key of order) {
    if (seen.has(key)) continue;
    seen.add(key);
    const now = current.get(key);
    const before = baseline?.get(key);
    if (!now && !before) continue;
    if (!now) {
      clinician.push({ key, title: before!.title, text: '', removed: true });
      continue;
    }
    if (baseline !== null && before && normalised(before.text) === normalised(now.text)) {
      ai.push({ key, title: now.title, text: now.text, removed: false });
    } else {
      clinician.push({ key, title: now.title, text: now.text, removed: false });
    }
  }

  return { clinician, ai, clinicianSections: clinician.map((s) => s.key), aiSections: ai.map((s) => s.key) };
}

export function renderDraftSections(sections: readonly DraftSection[]): string {
  return sections.map((section) => (section.removed ? `${section.title}: (removed by the clinician)` : `${section.title}: ${section.text}`)).join('\n\n');
}
