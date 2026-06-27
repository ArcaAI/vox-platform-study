'use client';

import * as React from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';

import type { AsyncCollection } from '@/lib/shared';

import type { AudioController, LiveTranscriptSegment } from './types';

export interface UseLiveTranscriptParams {
  segments: LiveTranscriptSegment[];
  interim?: string;
  editable?: boolean;
  editingPolicy?: 'final-only' | 'all';
  onEditSegment?: (id: string, text: string) => void | Promise<void>;
  showWords?: boolean;
  audioController?: AudioController;
  onWordClick?: (seg: LiveTranscriptSegment, word: NonNullable<LiveTranscriptSegment['wordTimestamps']>[number]) => void;
  autoScroll?: boolean;
  collection?: AsyncCollection<LiveTranscriptSegment>;
  estimateSegmentHeight?: number;
}

export interface ActiveWord {
  segmentId: string;
  index: number;
}

export interface UseLiveTranscriptResult {
  segments: LiveTranscriptSegment[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  isPinnedToBottom: boolean;
  jumpToLive: () => void;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  editingId: string | null;
  savingId: string | null;
  beginEdit: (id: string) => void;
  cancelEdit: () => void;
  saveEdit: (id: string, text: string) => Promise<void>;
  canEdit: (seg: LiveTranscriptSegment) => boolean;
  activeWord: ActiveWord | null;
  seekToWord: (seg: LiveTranscriptSegment, wordIndex: number) => void;
}

const BOTTOM_THRESHOLD = 24;
const TOP_THRESHOLD = 48;

export function useLiveTranscript(params: UseLiveTranscriptParams): UseLiveTranscriptResult {
  const {
    segments,
    interim,
    editable = false,
    editingPolicy = 'final-only',
    onEditSegment,
    audioController,
    onWordClick,
    autoScroll = true,
    collection,
    estimateSegmentHeight = 64,
  } = params;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const [isPinnedToBottom, setIsPinnedToBottom] = React.useState(true);

  // Merge code-switching glosses into their final by utteranceIndex (no dup rows),
  // then apply optimistic edit overrides.
  const displaySegments = React.useMemo<LiveTranscriptSegment[]>(() => {
    const glossByUtterance = new Map<number, string>();
    const finals: LiveTranscriptSegment[] = [];
    for (const seg of segments) {
      if (seg.resultType === 'gloss' && seg.utteranceIndex != null) {
        glossByUtterance.set(seg.utteranceIndex, seg.text);
        continue;
      }
      finals.push(seg);
    }
    return finals.map((seg) => ({
      ...seg,
      text: overrides[seg.id] ?? seg.text,
      englishText: seg.englishText ?? (seg.utteranceIndex != null ? glossByUtterance.get(seg.utteranceIndex) : undefined),
    }));
  }, [segments, overrides]);

  const virtualizer = useVirtualizer({
    count: displaySegments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSegmentHeight,
    overscan: 8,
    getItemKey: (index) => displaySegments[index]?.id ?? index,
  });

  const canEdit = React.useCallback((seg: LiveTranscriptSegment) => editable && (editingPolicy === 'all' || seg.isFinal), [editable, editingPolicy]);

  const beginEdit = React.useCallback(
    (id: string) => {
      const seg = displaySegments.find((s) => s.id === id);
      if (!seg || !canEdit(seg)) return;
      setEditingId(id); // single editor at a time
    },
    [displaySegments, canEdit],
  );

  const cancelEdit = React.useCallback(() => setEditingId(null), []);

  const saveEdit = React.useCallback(
    async (id: string, text: string) => {
      const previous = segments.find((s) => s.id === id)?.text;
      setOverrides((prev) => ({ ...prev, [id]: text })); // optimistic
      setEditingId(null);
      if (!onEditSegment) return;
      setSavingId(id);
      try {
        await onEditSegment(id, text);
      } catch {
        // revert + surface the failure (rule 11 §5).
        setOverrides((prev) => {
          const next = { ...prev };
          if (previous === undefined) delete next[id];
          else next[id] = previous;
          return next;
        });
        toast.error('Could not save your edit. Please try again.');
      } finally {
        setSavingId(null);
      }
    },
    [segments, onEditSegment],
  );

  const activeWord = React.useMemo<ActiveWord | null>(() => {
    const t = audioController?.currentTime;
    if (t == null) return null;
    for (const seg of displaySegments) {
      const words = seg.wordTimestamps;
      if (!words?.length) continue;
      for (let i = 0; i < words.length; i++) {
        if (t >= words[i].start && t < words[i].end) return { segmentId: seg.id, index: i };
      }
    }
    return null;
  }, [audioController?.currentTime, displaySegments]);

  const seekToWord = React.useCallback(
    (seg: LiveTranscriptSegment, wordIndex: number) => {
      const word = seg.wordTimestamps?.[wordIndex];
      if (!word) return;
      audioController?.seek(word.start);
      onWordClick?.(seg, word);
    },
    [audioController, onWordClick],
  );

  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setIsPinnedToBottom(distanceFromBottom <= BOTTOM_THRESHOLD);
      if (el.scrollTop <= TOP_THRESHOLD && collection?.hasNextPage && !collection?.isFetchingNextPage) {
        collection?.fetchNextPage?.();
      }
    },
    [collection],
  );

  const jumpToLive = React.useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setIsPinnedToBottom(true);
  }, []);

  // Autoscroll: stay pinned to the bottom as new content arrives (unless paused).
  React.useEffect(() => {
    if (!autoScroll || !isPinnedToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScroll, isPinnedToBottom, displaySegments.length, interim]);

  return {
    segments: displaySegments,
    scrollRef,
    virtualizer,
    isPinnedToBottom,
    jumpToLive,
    onScroll,
    editingId,
    savingId,
    beginEdit,
    cancelEdit,
    saveEdit,
    canEdit,
    activeWord,
    seekToWord,
  };
}
