'use client';

import * as React from 'react';

import {
  AudioPlayerButton,
  AudioPlayerDuration,
  AudioPlayerProgress,
  AudioPlayerProvider,
  AudioPlayerSpeed,
  AudioPlayerTime,
  useAudioPlayer,
  useAudioPlayerTime,
} from '@/components/elevenlabs/audio-player';
import { TranscriptWord } from '@/components/live-transcript/transcript-word';

import type { TimelineRendererProps, TimelineTranscriptSegment } from '../types';

/**
 * Audio content renderer (wraps the elevenlabs `AudioPlayer`). When a paired
 * transcript carries word-level timestamps (D9), renders clickable word tokens
 * that seek the player to `word.start`. The player never autoplays.
 */
export function AudioRenderer({ content }: TimelineRendererProps) {
  if (content.type !== 'audio') return null;
  const hasWords = !!content.transcript && content.transcript.segments.length > 0;
  return (
    <div data-slot="timeline-audio" className="space-y-3">
      <AudioPlayerProvider>
        <AudioControls src={content.src} title={content.title} />
        {hasWords ? <WordTranscript segments={content.transcript!.segments} /> : null}
      </AudioPlayerProvider>
    </div>
  );
}

function AudioControls({ src, title }: { src: string; title?: string }) {
  const item = React.useMemo(() => ({ id: src, src }), [src]);
  return (
    <div role="group" aria-label={title ? `Audio: ${title}` : 'Audio player'} className="flex items-center gap-2 rounded-md border bg-card p-2">
      <AudioPlayerButton item={item} variant="outline" size="icon" className="size-9 shrink-0" />
      <AudioPlayerTime className="w-12 shrink-0 text-right" />
      <AudioPlayerProgress aria-label="Seek" className="flex-1" />
      <AudioPlayerDuration className="w-12 shrink-0" />
      <AudioPlayerSpeed />
    </div>
  );
}

function WordTranscript({ segments }: { segments: TimelineTranscriptSegment[] }) {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  return (
    <div data-slot="timeline-audio-transcript" className="space-y-1.5 text-sm leading-relaxed text-foreground">
      {segments.map((segment) => (
        <p key={segment.id} className="flex flex-wrap items-baseline gap-x-1">
          {segment.speakerLabel ? <span className="mr-1 font-medium text-muted-foreground">{segment.speakerLabel}:</span> : null}
          {segment.words && segment.words.length > 0
            ? segment.words.map((word, i) => (
                <TranscriptWord
                  key={`${segment.id}-${i}`}
                  word={word}
                  active={time >= word.start && time < word.end}
                  onSelect={(w) => player.seek(w.start)}
                />
              ))
            : segment.text}
        </p>
      ))}
    </div>
  );
}
