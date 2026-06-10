/**
 * TranscriptList (TASK-351 P0-6 / H7).
 *
 * Extracted from `transcript-panel.tsx` and windowed: long sessions keep up
 * to 300 entries, but only the most recent `TRANSCRIPT_WINDOW_SIZE` rows are
 * mounted (with a "show earlier" expander) so partial-update re-renders stop
 * scaling with session length. Rows themselves are memoized
 * (`AudioTranscriptItem`).
 */

import type { TranscriptEntry } from '@/store/audio-store';
import { Button } from '@arcaai/ui/button';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AudioTranscriptItem } from './audio-transcript-item';

/** Default number of trailing entries rendered before the expander engages. */
export const TRANSCRIPT_WINDOW_SIZE = 60;

export function TranscriptList({
  entries,
  emptyMessage,
  onPlaySegment,
  activeSegmentId,
  windowSize = TRANSCRIPT_WINDOW_SIZE,
}: {
  entries: TranscriptEntry[];
  emptyMessage: string;
  onPlaySegment?: (entry: TranscriptEntry) => void;
  activeSegmentId?: string | null;
  windowSize?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const viewport = scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [entries.length]);

  const hiddenCount = showEarlier ? 0 : Math.max(0, entries.length - windowSize);
  const visibleEntries = hiddenCount > 0 ? entries.slice(hiddenCount) : entries;

  return (
    <ScrollArea className="h-96 rounded-lg border" ref={scrollRef}>
      {entries.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center py-16 text-center">
          <Languages className="text-muted-foreground mb-3 size-10" />
          <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        </div>
      ) : (
        <div className="space-y-1 p-2">
          {hiddenCount > 0 && (
            <Button type="button" variant="ghost" size="sm" className="w-full text-[11px]" onClick={() => setShowEarlier(true)}>
              Show {hiddenCount} earlier entries
            </Button>
          )}
          {visibleEntries.map((entry) => (
            <AudioTranscriptItem
              key={entry.id}
              entry={entry}
              onPlaySegment={onPlaySegment}
              isActiveSegment={activeSegmentId === entry.id}
              showSegmentBadge
              showTimingDetails
              showWordTimestamps
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}
