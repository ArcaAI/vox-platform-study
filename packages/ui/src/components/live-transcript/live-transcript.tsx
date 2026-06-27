'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

import { JumpToLive } from './jump-to-live';
import { ListeningPulse } from './listening-pulse';
import { TranscriptSegment } from './transcript-segment';
import { useLiveTranscript } from './use-live-transcript';
import type { LiveTranscriptProps } from './types';

export function LiveTranscript(props: LiveTranscriptProps) {
  const {
    segments,
    interim,
    isListening,
    editable,
    onEditSegment,
    editingPolicy,
    showWords,
    audioController,
    onWordClick,
    speakers,
    showTimestamps,
    showSpeakers,
    showConfidence,
    autoScroll,
    collection,
    renderSegment,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
    density = 'comfortable',
    estimateSegmentHeight = 64,
    height = 480,
    className,
  } = props;

  const ctrl = useLiveTranscript({
    segments,
    interim,
    editable,
    editingPolicy,
    onEditSegment,
    showWords,
    audioController,
    onWordClick,
    autoScroll,
    collection,
    estimateSegmentHeight,
  });

  const showError = error ?? collection?.error ?? null;
  const loading = isLoading ?? collection?.isLoading ?? false;
  const isEmpty = ctrl.segments.length === 0 && !interim;
  const virtualItems = ctrl.virtualizer.getVirtualItems();
  const hasAudio = !!audioController;

  return (
    <div data-slot="live-transcript" data-density={density} className={cn('flex w-full flex-col gap-2', className)}>
      <div className="flex items-center justify-between px-1">
        <ListeningPulse active={isListening} label={isListening ? 'Listening' : 'Idle'} />
      </div>

      {showError
        ? (errorState?.(showError) ?? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              <TriangleAlert className="size-4 shrink-0" />
              <span>{showError.message}</span>
            </div>
          ))
        : null}

      <div className="relative">
        <div
          ref={ctrl.scrollRef}
          role="log"
          // Pause announcements while editing to avoid churn (a11y §3.6.5).
          aria-live={ctrl.editingId ? 'off' : 'polite'}
          aria-relevant="additions"
          aria-label={props['aria-label'] ?? 'Live transcript'}
          aria-busy={loading || undefined}
          onScroll={ctrl.onScroll}
          className="relative overflow-auto rounded-md border bg-card"
          style={{ height: typeof height === 'number' ? `${height}px` : height }}
        >
          {loading && ctrl.segments.length === 0 ? (
            (loadingState ?? (
              <div data-testid="transcript-skeleton" className="space-y-3 p-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ))
          ) : isEmpty && !loading ? (
            isListening ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                <ListeningPulse active />
                <p>Listening… start speaking.</p>
              </div>
            ) : (
              (emptyState ?? (
                <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
                  <p className="font-medium">No transcript yet</p>
                  <p className="text-sm text-muted-foreground">Start recording to see the live transcript.</p>
                </div>
              ))
            )
          ) : (
            <>
              <div style={{ height: ctrl.virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const segment = ctrl.segments[virtualItem.index];
                  if (!segment) return null;
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={ctrl.virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
                      className={cn(density === 'compact' ? 'px-3' : 'px-4')}
                    >
                      <TranscriptSegment
                        segment={segment}
                        isEditing={ctrl.editingId === segment.id}
                        isSaving={ctrl.savingId === segment.id}
                        canEdit={ctrl.canEdit(segment)}
                        showWords={showWords}
                        showTimestamps={showTimestamps}
                        showSpeakers={showSpeakers}
                        showConfidence={showConfidence}
                        hasAudio={hasAudio}
                        activeWordIndex={ctrl.activeWord?.segmentId === segment.id ? ctrl.activeWord.index : null}
                        speakers={speakers}
                        renderSegment={renderSegment}
                        onBeginEdit={() => ctrl.beginEdit(segment.id)}
                        onSaveEdit={(text) => ctrl.saveEdit(segment.id, text)}
                        onCancelEdit={ctrl.cancelEdit}
                        onWordSelect={(wordIndex) => ctrl.seekToWord(segment, wordIndex)}
                      />
                    </div>
                  );
                })}
              </div>
              {interim ? (
                <p
                  data-slot="live-transcript-interim"
                  aria-live="off"
                  className={cn('italic text-muted-foreground', density === 'compact' ? 'px-3 py-1' : 'px-4 py-1.5')}
                >
                  {interim}
                </p>
              ) : null}
            </>
          )}
        </div>

        {!ctrl.isPinnedToBottom ? <JumpToLive onClick={ctrl.jumpToLive} /> : null}
      </div>
    </div>
  );
}

LiveTranscript.Segment = TranscriptSegment;
LiveTranscript.JumpToLive = JumpToLive;
LiveTranscript.ListeningPulse = ListeningPulse;
