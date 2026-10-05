/**
 * Which session finals re-finalise a consultation's note, and the keys the re-finalisation is
 * claimed under. Pure — `EncounterRefinalizeService` and the auto-pipeline handler must answer
 * the same question the same way, so both read it from here.
 *
 * A consultation is an episode of encounters with ONE note over all of them. The first stop's note
 * belongs to the auto-pipeline (`harness-doc`) or to the governing run started at open. Every later
 * stop that adds speech — the next encounter, or the same encounter recorded again — must re-write
 * that note over the whole consultation. The FULL_TRANSCRIPT item is rebuilt as a new VERSION at
 * each session final, so its version number (with the encounter number) is what tells the two apart.
 */

/** How long a re-finalisation claim lives: longer than any note generation, bounded like the note plan. */
export const NOTE_REFINALIZE_CLAIM_TTL_SECONDS = 7_200;

/** The `processingReason` a re-finalisation that could not be started leaves on FAILED. */
export const NOTE_REFINALIZE_FAILED = 'NOTE_REFINALIZE_FAILED';

export type SessionFinalKind = 'refinalize' | 'first' | 'not-stopped' | 'locked' | 'not-full-transcript';

const LOCKED_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE']);

/**
 * - `not-full-transcript` — the item is not the consultation's derived FULL_TRANSCRIPT (a legacy
 *   or batch transcript): not ours.
 * - `locked` — approved or closed: a signed note is never re-written.
 * - `not-stopped` — the consultation can still capture (a session swapped mid-recording, or the
 *   next encounter already open): the stop that ends it re-finalises.
 * - `first` — encounter 1's first transcript version: the first note, owned by its usual writer.
 * - `refinalize` — a later stop added speech to a consultation whose note already exists.
 */
export function classifySessionFinal(
  consultation: { status: string; currentEncounterSeq: number },
  item: { type: string; currentVersionNumber: number } | null,
): SessionFinalKind {
  if (!item || item.type !== 'FULL_TRANSCRIPT') return 'not-full-transcript';
  const status = String(consultation.status);
  if (LOCKED_STATUSES.has(status)) return 'locked';
  if (status !== 'STOPPED') return 'not-stopped';
  return item.currentVersionNumber > 1 || consultation.currentEncounterSeq > 1 ? 'refinalize' : 'first';
}

/** The transcript state a note is generated for: the FULL_TRANSCRIPT item at its current version. */
export function refinalizeStateKey(item: { id: string; currentVersionNumber: number }): string {
  return `${item.id}:v${item.currentVersionNumber}`;
}

/** One claim per (consultation, transcript state): whoever sets it generates; everyone else coalesces. */
export function noteRefinalizeClaimKey(consultationId: string, stateKey: string): string {
  return `consultation:note-refinalize:${consultationId}:${stateKey}`;
}
