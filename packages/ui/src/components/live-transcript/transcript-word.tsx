'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TranscriptWordData {
  word: string;
  start: number;
  end: number;
  /** `null` for the Whisper engine — render the word anyway (D9). */
  confidence?: number | null;
}

export interface TranscriptWordProps {
  word: TranscriptWordData;
  /** Highlight the currently-spoken word during playback (karaoke). */
  active?: boolean;
  /** When false (no seekable audio), render plain text instead of a button. */
  interactive?: boolean;
  /** Accessible label override, e.g. `Jump to 00:12 — "hello"`. */
  label?: string;
  onSelect?: (word: TranscriptWordData) => void;
  className?: string;
}

/**
 * A single clickable word token. Clicking seeks the paired
 * audio to `word.start`. Shared by the timeline audio renderer and `LiveTranscript`.
 */
export function TranscriptWord({ word, active, interactive = true, label, onSelect, className }: TranscriptWordProps) {
  if (!interactive) {
    return (
      <span data-slot="transcript-word" className={cn('rounded-sm px-0.5', className)}>
        {word.word}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-slot="transcript-word"
      data-active={active ? 'true' : undefined}
      aria-label={label}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect?.(word)}
      className={cn(
        'cursor-pointer rounded-sm px-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-[active=true]:bg-primary/15 data-[active=true]:text-foreground data-[active=true]:font-medium',
        className,
      )}
    >
      {word.word}
    </button>
  );
}
