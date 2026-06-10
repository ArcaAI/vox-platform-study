import type { TranscriptEntry } from '@/store/audio-store';

export const MAX_TRANSCRIPT_ENTRIES = 300;

/**
 * Maintain a stable transcript list with at most one trailing partial entry.
 * This avoids repeated full-array filtering on every partial update.
 *
 * TASK-351 P0-6 (H7): exactly one array allocation per call (previously up
 * to three via slice + spread + trim-slice), and retained rows keep their
 * references so memoized list rows skip re-rendering.
 */
export function upsertTranscriptEntry(
  previousEntries: TranscriptEntry[],
  nextEntry: TranscriptEntry,
  maxEntries = MAX_TRANSCRIPT_ENTRIES,
): TranscriptEntry[] {
  const hasTrailingPartial = previousEntries.length > 0 && !previousEntries[previousEntries.length - 1]!.isFinal;
  // Retained rows are previous[keepStart, keepEnd); nextEntry is appended.
  const keepEnd = hasTrailingPartial ? previousEntries.length - 1 : previousEntries.length;
  const keepStart = Math.max(0, keepEnd + 1 - maxEntries);

  const nextEntries = new Array<TranscriptEntry>(keepEnd - keepStart + 1);
  for (let i = keepStart; i < keepEnd; i++) {
    nextEntries[i - keepStart] = previousEntries[i]!;
  }
  nextEntries[nextEntries.length - 1] = nextEntry;
  return nextEntries;
}
