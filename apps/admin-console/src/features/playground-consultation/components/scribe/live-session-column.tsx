'use client';

/**
 * Column 2 of the Consultation Scribe workspace (TASK-543): the live
 * session. A recording bar (REC pill + elapsed timer + level-driven waveform +
 * start/stop) over the canonical `LiveTranscript` composite fed straight from
 * the SDK (`audio.transcriptSegments` + `audio.currentTranscript`).
 *
 * The waveform renders a rolling buffer of the SDK's `audio.level` — one
 * amplitude source of truth (no second `getUserMedia`). `audio.level` is now
 * live: the SDK samples an AnalyserNode on the capture graph (TASK-543), so the
 * bars track the mic input while recording.
 *
 * TASK-552 Lane C — click-to-source review mode: `audio.transcriptSegments`
 * are the SDK's LIVE, in-browser STT segments (ephemeral, no relationship to
 * the persisted transcript's character offsets a citation resolves to). Once
 * a `reviewTranscriptText` prop is supplied (the persisted transcript,
 * post-recording) and capture is NOT active, this column renders that text
 * instead, highlighting + scrolling to `reviewHighlight` when the clinician
 * clicks a citation in the case-note column's evidence panel. Absent
 * `reviewTranscriptText`, behavior is unchanged (the live SDK view).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowsExchange, IconMicrophone, IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react';
import { LiveTranscript, type LiveTranscriptSegment } from '@arcaai/ui';
import { Waveform } from '@arcaai/ui/components/elevenlabs/waveform';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { cn } from '@arcaai/ui';
import { EmptyState } from '@/shared/state/empty-state';

const WAVE_BARS = 80;
const WAVE_FLOOR = 0.08;
/** Shared flat idle waveform — rendered when capture is off (never mutated in place). */
const IDLE_WAVE: number[] = Array.from({ length: WAVE_BARS }, () => WAVE_FLOOR);

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** SDK store segment → LiveTranscript segment (id from index — the store list is append-only). */
export interface SdkTranscriptSegment {
  text: string;
  startTime?: number;
  endTime?: number;
  isFinal?: boolean;
  speakerLabel?: string;
  confidence?: number;
  language?: string;
  words?: Array<{ word: string; start: number; end: number; confidence?: number | null }>;
}

export function toLiveTranscriptSegments(segments: readonly SdkTranscriptSegment[]): LiveTranscriptSegment[] {
  return segments.map((segment, index) => ({
    id: `seg-${index}`,
    text: segment.text,
    startTime: segment.startTime,
    endTime: segment.endTime,
    isFinal: segment.isFinal ?? true,
    speakerLabel: segment.speakerLabel,
    confidence: segment.confidence,
    language: segment.language,
    wordTimestamps: segment.words,
  }));
}

/** A character span to highlight within `reviewTranscriptText` (TASK-552 Lane C). */
export interface TranscriptReviewHighlight {
  charStart: number;
  charEnd: number;
}

/** Persisted-transcript review pane: plain text, with an optional highlighted + auto-scrolled span. */
function TranscriptReview({ text, highlight }: { text: string; highlight: TranscriptReviewHighlight | null | undefined }) {
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (highlight) markRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // `highlight` is memoized by the caller (stable reference unless the
    // cited span actually changes) — see consultation-demo-screen.tsx.
  }, [highlight]);

  const valid = !!highlight && highlight.charStart >= 0 && highlight.charEnd <= text.length && highlight.charStart < highlight.charEnd;
  if (!valid) {
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap" aria-label="Persisted transcript">
        {text}
      </p>
    );
  }

  const before = text.slice(0, highlight.charStart);
  const marked = text.slice(highlight.charStart, highlight.charEnd);
  const after = text.slice(highlight.charEnd);

  return (
    <p className="text-sm leading-relaxed whitespace-pre-wrap" aria-label="Persisted transcript">
      {before}
      <mark ref={markRef} className="bg-primary/25 text-foreground rounded px-0.5">
        {marked}
      </mark>
      {after}
    </p>
  );
}

export interface LiveSessionColumnProps {
  hasConsultation: boolean;
  isRecording: boolean;
  /** Mic capture actually running (SDK `audio.isCapturing`). */
  isCapturing: boolean;
  captureBusy: boolean;
  canRecord: boolean;
  /** SDK `audio.level` (0–100). */
  level: number;
  segments: readonly SdkTranscriptSegment[];
  /** SDK `audio.currentTranscript` — the in-flight partial. */
  interim: string;
  onStart: () => void;
  onStop: () => void;
  /** Persisted transcript text (TASK-552 Lane C) — renders in place of the live SDK view while not capturing. */
  reviewTranscriptText?: string | null;
  /** The cited span to highlight + scroll to within `reviewTranscriptText`. */
  reviewHighlight?: TranscriptReviewHighlight | null;
  /** SDK `audio.sttConnectionState` — drives the reconnecting/error/switch banner (TASK-567). */
  sttConnectionState?: 'connected' | 'reconnecting' | 'switched_fallback' | 'error';
  /** True once the live session has switched to the tenant fallback pipeline (SDK `audio.activePipeline.isFallback`). */
  onFallback?: boolean;
  /** Request an on-the-fly switch to the tenant fallback pipeline (SDK `audio.switchToFallback`). */
  onSwitchToFallback?: () => void;
}

export function LiveSessionColumn({
  hasConsultation,
  isRecording,
  isCapturing,
  captureBusy,
  canRecord,
  level,
  segments,
  interim,
  onStart,
  onStop,
  reviewTranscriptText = null,
  reviewHighlight = null,
  sttConnectionState = 'connected',
  onFallback = false,
  onSwitchToFallback,
}: LiveSessionColumnProps) {
  // Rolling amplitude buffer + elapsed seconds. State is written ONLY inside
  // the interval callbacks (never synchronously in the effect body, and no
  // ref/clock reads during render); idle values are derived purely.
  const [wave, setWave] = useState<number[]>(IDLE_WAVE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    if (!isCapturing) return;
    const startedAt = Date.now();
    const waveTimer = setInterval(() => {
      setWave((previous) => {
        const next = previous.slice(1);
        next.push(Math.max(WAVE_FLOOR, Math.min(1, levelRef.current / 100)));
        return next;
      });
    }, 80);
    const elapsedTimer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => {
      clearInterval(waveTimer);
      clearInterval(elapsedTimer);
    };
  }, [isCapturing]);

  const displayElapsed = isCapturing ? elapsedSeconds : 0;
  const displayWave = isCapturing ? wave : IDLE_WAVE;
  const transcriptSegments = useMemo(() => toLiveTranscriptSegments(segments), [segments]);

  return (
    <section aria-label="Live session" className="bg-background flex h-full min-h-0 flex-col">
      <div className="bg-card m-3 mb-1 flex shrink-0 items-center gap-3.5 rounded-xl border p-3 shadow-sm">
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5',
            isRecording ? 'border-destructive/35 bg-destructive/10' : 'border-border bg-muted/50',
          )}
        >
          <span aria-hidden className={cn('size-2 rounded-full', isRecording ? 'bg-destructive animate-pulse' : 'bg-muted-foreground')} />
          <span className={cn('text-sm font-bold', isRecording ? 'text-destructive' : 'text-muted-foreground')}>
            {isRecording ? 'Recording' : 'Idle'}
          </span>
          <span className="font-mono text-sm font-semibold" aria-label="Elapsed time">
            {formatElapsed(displayElapsed)}
          </span>
        </div>
        <div aria-hidden className="text-primary min-w-0 flex-1">
          <Waveform data={displayWave} active={isCapturing} height={40} />
        </div>
        {/* On-the-fly switch to the tenant fallback pipeline (TASK-567 R4). */}
        {isCapturing && onSwitchToFallback && !onFallback ? (
          <Button variant="outline" onClick={onSwitchToFallback} disabled={captureBusy} className="shrink-0">
            <IconArrowsExchange aria-hidden />
            Use fallback
          </Button>
        ) : null}
        {isRecording ? (
          <Button variant="outline" onClick={onStop} disabled={captureBusy} className="border-destructive text-destructive shrink-0">
            {captureBusy ? <Spinner aria-hidden /> : <IconPlayerStop aria-hidden />}
            Stop
          </Button>
        ) : (
          <Button onClick={onStart} disabled={!canRecord || captureBusy} className="shrink-0">
            {captureBusy ? <Spinner aria-hidden /> : <IconPlayerPlay aria-hidden />}
            Start
          </Button>
        )}
      </div>
      {/* Switch / connection banner (TASK-567): shown only off the nominal state. */}
      {onFallback || sttConnectionState === 'reconnecting' || sttConnectionState === 'error' ? (
        <div
          role="status"
          className={cn(
            'mx-3 mb-1 shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium',
            sttConnectionState === 'error'
              ? 'border-destructive/35 bg-destructive/10 text-destructive'
              : 'border-warning/35 bg-warning/10 text-warning-foreground',
          )}
        >
          {sttConnectionState === 'error'
            ? 'Transcription connection lost — the session could not be recovered.'
            : sttConnectionState === 'reconnecting'
              ? 'Reconnecting transcription…'
              : 'Switched to the fallback transcription provider.'}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!hasConsultation ? (
          <EmptyState
            icon={IconMicrophone}
            title="No consultation selected"
            description="Pick a consultation on the left — or open a new one — to start a live session."
          />
        ) : reviewTranscriptText && !isCapturing ? (
          <TranscriptReview text={reviewTranscriptText} highlight={reviewHighlight} />
        ) : (
          <LiveTranscript
            segments={transcriptSegments}
            interim={interim || undefined}
            isListening={isCapturing}
            showSpeakers
            showTimestamps
            autoScroll
            height="100%"
            aria-label="Live consultation transcript"
          />
        )}
      </div>
    </section>
  );
}
