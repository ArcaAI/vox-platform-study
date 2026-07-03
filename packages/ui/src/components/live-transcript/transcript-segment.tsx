'use client';

import * as React from 'react';
import { Pencil } from 'lucide-react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

import { TranscriptWord } from './transcript-word';
import type { SegmentEditorProps } from './segment-editor';
import type { LiveTranscriptSegment, SpeakerConfig } from './types';

// NodeNext (dts build) requires an explicit extension on relative dynamic imports;
// esbuild rewrites `.js` → `.tsx` for the JS bundle. The `as unknown as …` keeps the
// dts (CJS-interop) view of the default export aligned with esbuild's ESM runtime
// shape; paths aren't applied to un-inlined dynamic imports in the dts bundle.
// TASK-410 re-verified (tsc 5.9): dropping the extension → TS2835; dropping the cast →
// TS2322 (CJS interop wraps the module namespace as `default`) — still required.
const LazySegmentEditor = React.lazy(() => import('./segment-editor.js') as unknown as Promise<{ default: React.ComponentType<SegmentEditorProps> }>);

const SPEAKER_TONE: Record<NonNullable<SpeakerConfig['colorRole']>, string> = {
  primary: 'text-primary',
  ai: 'text-primary',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-indigo-600 dark:text-indigo-400',
};

function formatClock(seconds?: number): string | null {
  if (seconds == null || Number.isNaN(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface TranscriptSegmentProps {
  segment: LiveTranscriptSegment;
  isEditing: boolean;
  isSaving: boolean;
  canEdit: boolean;
  showWords?: boolean;
  showTimestamps?: boolean;
  showSpeakers?: boolean;
  showConfidence?: boolean;
  hasAudio?: boolean;
  activeWordIndex?: number | null;
  speakers?: Record<string, SpeakerConfig>;
  onBeginEdit?: () => void;
  onSaveEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  onWordSelect?: (wordIndex: number) => void;
  renderSegment?: (seg: LiveTranscriptSegment, ctx: { isEditing: boolean }) => React.ReactNode;
}

export function TranscriptSegment({
  segment,
  isEditing,
  isSaving,
  canEdit,
  showWords,
  showTimestamps,
  showSpeakers = true,
  showConfidence,
  hasAudio,
  activeWordIndex,
  speakers,
  onBeginEdit,
  onSaveEdit,
  onCancelEdit,
  onWordSelect,
  renderSegment,
}: TranscriptSegmentProps) {
  const speakerConfig = segment.speakerLabel ? speakers?.[segment.speakerLabel] : undefined;
  const speakerLabel = speakerConfig?.label ?? segment.speakerLabel;
  const timestamp = formatClock(segment.startTime);
  const hasWords = !!segment.wordTimestamps && segment.wordTimestamps.length > 0;

  return (
    <div
      data-slot="transcript-segment"
      data-final={segment.isFinal ? 'true' : 'false'}
      // Interim rows are not announced by the live region (avoid SR spam).
      aria-live={segment.isFinal ? undefined : 'off'}
      className="space-y-1 py-1.5"
    >
      {(showSpeakers && speakerLabel) || (showTimestamps && timestamp) || (showConfidence && segment.confidence != null) || canEdit ? (
        <div className="flex items-center gap-2">
          {showSpeakers && speakerLabel ? (
            <span className={cn('text-xs font-semibold', SPEAKER_TONE[speakerConfig?.colorRole ?? 'primary'])}>{speakerLabel}</span>
          ) : null}
          {showTimestamps && timestamp ? (
            <time className="text-xs tabular-nums text-muted-foreground" dateTime={`PT${Math.floor(segment.startTime ?? 0)}S`}>
              {timestamp}
            </time>
          ) : null}
          {showConfidence && segment.confidence != null ? (
            <Badge variant="outline" className="text-[10px]">
              {Math.round(segment.confidence * 100)}%
            </Badge>
          ) : null}
          {canEdit && !isEditing ? (
            <Button type="button" variant="ghost" size="icon" className="ml-auto size-6" aria-label="Edit segment" onClick={onBeginEdit}>
              <Pencil className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {isEditing ? (
        <React.Suspense
          fallback={
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{segment.text}</span>
              <span
                role="status"
                aria-label="Loading editor"
                className="size-3 animate-spin rounded-full border-2 border-muted border-t-foreground"
              />
            </div>
          }
        >
          <LazySegmentEditor initialText={segment.text} saving={isSaving} onSave={(text) => onSaveEdit?.(text)} onCancel={() => onCancelEdit?.()} />
        </React.Suspense>
      ) : renderSegment ? (
        renderSegment(segment, { isEditing: false })
      ) : (
        <SegmentBody
          segment={segment}
          showWords={showWords}
          hasWords={hasWords}
          hasAudio={hasAudio}
          activeWordIndex={activeWordIndex}
          onWordSelect={onWordSelect}
        />
      )}

      {!isEditing && segment.englishText ? <p className="text-xs italic text-muted-foreground">{segment.englishText}</p> : null}
    </div>
  );
}

function SegmentBody({
  segment,
  showWords,
  hasWords,
  hasAudio,
  activeWordIndex,
  onWordSelect,
}: {
  segment: LiveTranscriptSegment;
  showWords?: boolean;
  hasWords: boolean;
  hasAudio?: boolean;
  activeWordIndex?: number | null;
  onWordSelect?: (wordIndex: number) => void;
}) {
  const baseClass = cn('text-sm leading-relaxed', segment.isFinal ? 'text-foreground' : 'italic text-muted-foreground');

  if (showWords && hasWords) {
    return (
      <p className={cn('flex flex-wrap items-baseline gap-x-1', baseClass)}>
        {segment.wordTimestamps!.map((word, i) => (
          <TranscriptWord
            key={`${segment.id}-${i}`}
            word={word}
            interactive={!!hasAudio}
            active={activeWordIndex === i}
            label={hasAudio ? `Jump to ${formatClock(word.start)} — ${word.word}` : undefined}
            onSelect={hasAudio ? () => onWordSelect?.(i) : undefined}
          />
        ))}
      </p>
    );
  }

  // stableChars: committed prefix renders settled; the tail renders tentatively.
  if (!segment.isFinal && segment.stableChars != null && segment.stableChars > 0 && segment.stableChars < segment.text.length) {
    return (
      <p className={baseClass}>
        <span className="not-italic text-foreground">{segment.text.slice(0, segment.stableChars)}</span>
        <span>{segment.text.slice(segment.stableChars)}</span>
      </p>
    );
  }

  return <p className={baseClass}>{segment.text}</p>;
}
