import { memo } from 'react';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import type { TranscriptEntry } from '@/store/audio-store';
import { Clock, Play, Square, User } from 'lucide-react';

export function formatTranscriptTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface AudioTranscriptItemProps {
  entry: TranscriptEntry;
  onPlaySegment?: (entry: TranscriptEntry) => void;
  isActiveSegment?: boolean;
  showSegmentBadge?: boolean;
  showTimingDetails?: boolean;
  showWordTimestamps?: boolean;
}

function AudioTranscriptItemInner({
  entry,
  onPlaySegment,
  isActiveSegment = false,
  showSegmentBadge = false,
  showTimingDetails = false,
  showWordTimestamps = false,
}: AudioTranscriptItemProps) {
  const speakerDisplay = entry.speakerLabel ?? entry.speaker;
  const canReplay = Boolean(onPlaySegment && entry.isFinal && entry.end > entry.start);

  return (
    <div className="group flex gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50">
      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
        {showSegmentBadge && entry.isFinal && (
          <Badge variant="outline" className="font-mono text-[10px]">
            #{entry.segment}
          </Badge>
        )}
        {speakerDisplay && (
          <Badge variant="outline" className="text-[10px]">
            <User className="mr-0.5 size-2.5" />
            {speakerDisplay}
          </Badge>
        )}
        <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
          <Clock className="size-2.5" />
          {formatTranscriptTimestamp(entry.timestamp)}
        </span>
      </div>
      <div className="flex-1">
        <p className={entry.isFinal ? 'text-sm' : 'text-muted-foreground text-sm italic'}>{entry.text}</p>
        {showTimingDetails && entry.isFinal && (
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-[10px]">
            <span className="font-mono">
              {entry.start.toFixed(3)}s–{entry.end.toFixed(3)}s
            </span>
            <span>dur {entry.duration.toFixed(3)}s</span>
            <span>inf {entry.inference.toFixed(4)}s</span>
          </div>
        )}
        {showWordTimestamps && entry.isFinal && entry.wordTimestamps && entry.wordTimestamps.length > 0 && (
          <div className="text-muted-foreground mt-1 flex flex-wrap gap-1 text-[10px]">
            {entry.wordTimestamps.map((word, index) => (
              <span key={`${entry.id}-word-${index}`} className="rounded bg-muted px-1 py-0.5">
                {word.word} [{word.start.toFixed(3)}-{word.end.toFixed(3)}s] c={word.confidence.toFixed(3)}
              </span>
            ))}
          </div>
        )}
      </div>
      {!entry.isFinal && (
        <Badge variant="secondary" className="shrink-0 self-start text-[10px]">
          partial
        </Badge>
      )}
      {canReplay && (
        <Button
          type="button"
          size="sm"
          variant={isActiveSegment ? 'default' : 'ghost'}
          className="h-7 gap-1 px-2 text-[10px]"
          onClick={() => onPlaySegment?.(entry)}
        >
          {isActiveSegment ? <Square className="size-3" /> : <Play className="size-3" />}
          {isActiveSegment ? 'Playing' : 'Replay'}
        </Button>
      )}
    </div>
  );
}

export const AudioTranscriptItem = memo(AudioTranscriptItemInner);
