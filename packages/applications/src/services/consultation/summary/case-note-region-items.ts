/**
 * TASK-1050 finding D — the CASE_NOTE items a pre-summary places in its `case_notes` data region, for
 * the guardrail evaluation's `region_items`: exactly the notes the prompt carries (non-empty, and not
 * a copy of a client-stated prior visit), each at its current version.
 */
import { DATA_SECTIONS } from '../prompt/prompt-assembly-blocks';
import type { GuardrailRegionItems } from '../../text-request/guardrail-correlation';

/** The region key the case-note section is composed under (the composer names regions by block key). */
export const CASE_NOTES_REGION_KEY = DATA_SECTIONS.find((section) => section.variable === 'case_notes')!.key;

export function caseNoteRegionItems(
  notes: ReadonlyArray<{ id: string; content?: string | null; currentVersionNumber?: number } | null | undefined>,
  duplicated: ReadonlySet<string> | null | undefined,
): GuardrailRegionItems {
  const refs = notes
    .filter((note): note is { id: string; content?: string | null; currentVersionNumber?: number } => !!note?.id)
    .filter((note) => {
      const text = (note.content ?? '').trim();
      return text.length > 0 && !duplicated?.has(text);
    })
    .map((note) => ({ itemId: note.id, itemVersion: Number(note.currentVersionNumber ?? 1) }));
  return refs.length > 0 ? { [CASE_NOTES_REGION_KEY]: refs } : {};
}
