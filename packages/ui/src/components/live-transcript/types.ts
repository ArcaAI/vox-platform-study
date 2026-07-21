/**
 * Types for LiveTranscript — the canonical realtime transcript
 * (D6). `LiveTranscriptSegment` is a superset of the SDK store `TranscriptSegment`
 * AND the wire `WsTranscriptResult` so consumers can feed either source (D9).
 */
import type * as React from 'react';
import type { AsyncCollection, AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';

export interface LiveTranscriptWord {
  word: string;
  start: number;
  end: number;
  /** `null` for the Whisper engine — render anyway (D9). */
  confidence?: number | null;
}

export interface LiveTranscriptSegment {
  id: string;
  text: string;
  startTime?: number;
  endTime?: number;
  isFinal: boolean;
  /** Committed-prefix length on partials (render the tail tentatively). */
  stableChars?: number;
  speakerLabel?: string;
  speakerConfidence?: number;
  confidence?: number;
  language?: string;
  /** Code-switching gloss (English rendering of a non-English utterance). */
  englishText?: string;
  resultType?: 'segment' | 'gloss';
  utteranceIndex?: number;
  wordTimestamps?: LiveTranscriptWord[];
}

export interface SpeakerConfig {
  label: string;
  colorRole?: 'ai' | 'success' | 'warning' | 'primary' | 'info';
}

export interface AudioController {
  seek: (seconds: number) => void;
  currentTime?: number;
}

export interface LiveTranscriptProps extends BaseSurfaceProps, AsyncStateProps {
  segments: LiveTranscriptSegment[];
  /** `audio.currentTranscript` — the live partial. */
  interim?: string;
  isListening?: boolean;
  // editing (D4 — Lexical inline editor)
  editable?: boolean;
  onEditSegment?: (id: string, text: string) => void | Promise<void>;
  editingPolicy?: 'final-only' | 'all';
  // word-level timestamps + click-to-seek (D9)
  showWords?: boolean;
  audioController?: AudioController;
  onWordClick?: (seg: LiveTranscriptSegment, word: LiveTranscriptWord) => void;
  // diarization
  speakers?: Record<string, SpeakerConfig>;
  showTimestamps?: boolean;
  showSpeakers?: boolean;
  showConfidence?: boolean;
  // scrolling
  autoScroll?: boolean;
  // infinite history (older segments)
  collection?: AsyncCollection<LiveTranscriptSegment>;
  // slots / render props
  renderSegment?: (seg: LiveTranscriptSegment, ctx: { isEditing: boolean }) => React.ReactNode;
  estimateSegmentHeight?: number;
  height?: number | string;
  'aria-label'?: string;
}
