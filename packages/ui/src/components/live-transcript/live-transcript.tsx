'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

import { JumpToLive } from './jump-to-live';
import { ListeningPulse } from './listening-pulse';
import { TranscriptSegment } from './transcript-segment';
import { TranscriptParagraphView } from './transcript-paragraph';
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
    paragraphGapSeconds,
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
    paragraphGapSeconds,
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
          // Pause announcements while editing to avoid churn (a11y
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
                  const paragraph = ctrl.paragraphs[virtualItem.index];
                  if (!paragraph) return null;
                  const lead = paragraph.segments[0];
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={ctrl.virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
                      className={cn(density === 'compact' ? 'px-3' : 'px-4')}
                    >
                      {paragraph.segments.length > 1 ? (
                        <TranscriptParagraphView
                          paragraph={paragraph}
                          showWords={showWords}
                          showTimestamps={showTimestamps}
                          showSpeakers={showSpeakers}
                          showConfidence={showConfidence}
                          hasAudio={hasAudio}
                          activeWord={ctrl.activeWord}
                          speakers={speakers}
                          onWordSelect={(member, wordIndex) => ctrl.seekToWord(member, wordIndex)}
                        />
                      ) : (
                        <TranscriptSegment
                          segment={lead}
                          isEditing={ctrl.editingId === lead.id}
                          isSaving={ctrl.savingId === lead.id}
                          canEdit={ctrl.canEdit(lead)}
                          showWords={showWords}
                          showTimestamps={showTimestamps}
                          showSpeakers={showSpeakers}
                          showConfidence={showConfidence}
                          hasAudio={hasAudio}
                          activeWordIndex={ctrl.activeWord?.segmentId === lead.id ? ctrl.activeWord.index : null}
                          speakers={speakers}
                          renderSegment={renderSegment}
                          onBeginEdit={() => ctrl.beginEdit(lead.id)}
                          onSaveEdit={(text) => ctrl.saveEdit(lead.id, text)}
                          onCancelEdit={ctrl.cancelEdit}
                          onWordSelect={(wordIndex) => ctrl.seekToWord(lead, wordIndex)}
                        />
                      )}
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
