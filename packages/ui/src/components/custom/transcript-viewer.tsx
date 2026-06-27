'use client';

import { useRef, useEffect } from 'react';
import { IconMessage } from '@tabler/icons-react';

import { cn } from '../../lib/utils';
import { ScrollArea } from '../shadcn/scroll-area';
import { Badge } from '../shadcn/badge';

export interface TranscriptEntry {
  id: string;
  text: string;
  timestamp?: string;
  speaker?: string;
  isFinal: boolean;
}

export interface TranscriptViewerProps {
  entries: TranscriptEntry[];
  currentTranscript?: string;
  className?: string;
  maxHeight?: string;
}

/**
 * @deprecated Use `LiveTranscript` (the canonical realtime transcript, TASK-372 D6) from
 * `@arcaai/ui` instead. `LiveTranscript` supersedes this viewer with virtualization,
 * inline Lexical editing, word-level timestamps + click-to-seek, and jump-to-live. This
 * component is retained for backwards compatibility and is not deleted.
 * @see LiveTranscript
 */
export function TranscriptViewer({ entries, currentTranscript, className, maxHeight = '400px' }: TranscriptViewerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, currentTranscript]);

  const isEmpty = entries.length === 0 && !currentTranscript;

  if (isEmpty) {
    return (
      <div
        className={cn('flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center', className)}
        style={{ minHeight: maxHeight }}
      >
        <IconMessage className="size-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No transcripts yet</p>
      </div>
    );
  }

  return (
    <ScrollArea className={cn('rounded-lg border', className)} style={{ maxHeight }}>
      <div className="flex flex-col gap-3 p-4">
        {entries.map((entry) => (
          <div key={entry.id} className={cn('flex flex-col gap-1', !entry.isFinal && 'opacity-60')}>
            <div className="flex items-center gap-2">
              {entry.timestamp && <span className="text-xs text-muted-foreground">{entry.timestamp}</span>}
              {entry.speaker && (
                <Badge variant="secondary" className="text-xs">
                  {entry.speaker}
                </Badge>
              )}
            </div>
            <p className={cn('text-sm leading-relaxed', !entry.isFinal && 'italic text-muted-foreground')}>{entry.text}</p>
          </div>
        ))}

        {currentTranscript && (
          <div className="flex items-start gap-2">
            <span className="relative mt-1.5 flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <p className="text-sm italic text-muted-foreground leading-relaxed">{currentTranscript}</p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
