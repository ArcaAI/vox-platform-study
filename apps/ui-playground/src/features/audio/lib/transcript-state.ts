import type { TranscriptEntry } from '@/store/audio-store';

export const MAX_TRANSCRIPT_ENTRIES = 300;

/**
 * Maintain a stable transcript list with at most one trailing partial entry.
 * This avoids repeated full-array filtering on every partial update.
 */
export function upsertTranscriptEntry(
    previousEntries: TranscriptEntry[],
    nextEntry: TranscriptEntry,
    maxEntries = MAX_TRANSCRIPT_ENTRIES,
): TranscriptEntry[] {
    const hasTrailingPartial = previousEntries.length > 0 && !previousEntries[previousEntries.length - 1]!.isFinal;
    const baseEntries = hasTrailingPartial ? previousEntries.slice(0, -1) : previousEntries;
    const nextEntries = [...baseEntries, nextEntry];

    if (nextEntries.length <= maxEntries) {
        return nextEntries;
    }

    return nextEntries.slice(nextEntries.length - maxEntries);
}
