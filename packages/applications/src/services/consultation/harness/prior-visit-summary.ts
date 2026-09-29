/**
 * Bounding the PRIOR-VISIT summary a re-visit consultation carries into its prompt.
 *
 * The carry-forward DECISION is the assigned graph's `carryForward` binding (TASK-882; read by
 * `ConfigResolver.resolveRevisitCarryForwardEnabled`). What is bounded here is the CONTENT:
 * a whole prior note is real prompt budget, and an unbounded carry is how a re-visit prompt
 * grows without limit across a long care episode.
 *
 * TASK-1020 — this module also owns the ONE note-authority selection
 * ({@link selectAuthoritativeNoteText}) that both the prior-visit carry-forward and the same-day
 * prequel (`same-day-prequel.ts`) pick a consultation's note with, so the two can never disagree
 * about which of a visit's notes is "the" note.
 */
import { ContextItemType } from '@arcaai/domains';

/** Hard cap on the carried prior-visit summary. */
export const PRIOR_VISIT_SUMMARY_MAX_CHARS = 15_000;

/** Appended when the prior-visit summary is cut at the cap. */
export const PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER = '…[prior visit summary truncated]';

/**
 * Bound a carried prior-visit summary, marking the cut so neither the model nor a reviewer can
 * mistake a truncated note for a complete one.
 *
 * Applied at BOTH ends on purpose: the producer (`HarnessInternalService.assemble`) caps what
 * it carries, and prompt assembly caps again immediately before the text reaches the prompt.
 * Assembly is the shared entry point for every caller, so the second application is what
 * makes the bound a property of the PROMPT rather than of one producer.
 */
export function truncatePriorVisitSummary(text: string): string {
  if (text.length <= PRIOR_VISIT_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, PRIOR_VISIT_SUMMARY_MAX_CHARS)}${PRIOR_VISIT_SUMMARY_TRUNCATION_MARKER}`;
}

/** The one repository read {@link selectAuthoritativeNoteText} needs — `ContextItemRepository.findByType`. */
export interface AuthoritativeNoteReader {
  findByType(consultationId: string, type: ContextItemType): Promise<ReadonlyArray<{ content?: string | null; createdAt: Date }> | null | undefined>;
}

/**
 * The most authoritative note of `consultationId`, trimmed and UNBOUNDED, or `null`.
 *
 * Authority order is `SIGNED_NOTE` → `MODIFIED_SUMMARY` → `RAW_SUMMARY`: a note the clinician
 * signed outranks one they merely edited, which outranks a raw model draft. (Built inside the call,
 * not at module scope: several suites mock `@arcaai/domains` wholesale, and a module-scope enum read
 * would throw at import for every file that merely reaches this one.)
 *
 * Only the FIRST tier that yields a non-blank note is used —
 * mixing tiers would carry a superseded draft alongside the signed note. Within a tier the newest
 * row wins (`findByType` sorts ascending, so reduce rather than index). Content arrives already
 * decrypted (repository decrypt-on-read).
 *
 * Throws what the reader throws: each caller decides its own degrade posture and its own bound.
 */
export async function selectAuthoritativeNoteText(reader: AuthoritativeNoteReader, consultationId: string): Promise<string | null> {
  for (const type of [ContextItemType.SIGNED_NOTE, ContextItemType.MODIFIED_SUMMARY, ContextItemType.RAW_SUMMARY]) {
    const items = (await reader.findByType(consultationId, type)) ?? [];
    const usable = items.filter((item) => item?.content?.trim());
    if (usable.length === 0) continue;
    const newest = usable.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    return newest.content!.trim();
  }
  return null;
}
