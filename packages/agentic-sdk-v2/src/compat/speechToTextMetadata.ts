'use client';

/**
 * @arcaai/vox/compat - useArcaSpeechToText metadata helpers (TASK-565)
 *
 * Pure functions implementing the frozen metadata-passthrough contract
 * (TASK-564 §5). Kept separate so the F4 fix (§5.2 precedence) and §4.3
 * normalization are unit-testable in isolation.
 */

/** v1-parity default when `transcriptTemplate` is absent (TASK-564 §5.2). */
export const DEFAULT_TRANSCRIPT_TEMPLATE = '{timestamp} {speaker_id}: {text}';

/** Fields the hook derives from a v2 `TranscriptSegment` (all optional). */
export interface EnrichmentSeg {
  speakerLabel?: string;
  confidence?: number;
  language?: string;
  startTime?: number;
  endTime?: number;
}

/**
 * §4.3 `chunk_id` normalization: caller `chunk_id → chunkId → other` (v1 priority).
 * v2 has no server-assigned chunk id — it echoes what the caller supplied.
 */
export function resolveChunkId(meta: Record<string, unknown> | undefined): unknown | undefined {
  if (!meta) return undefined;
  if (meta.chunk_id !== undefined) return meta.chunk_id;
  if (meta.chunkId !== undefined) return meta.chunkId;
  if (meta.other !== undefined) return meta.other;
  return undefined;
}

/**
 * §4.3 `detected_language` normalization:
 * caller `detected_language → detectedLanguage → seg.language`.
 * v2 uses the session-configured language (not per-utterance detection) unless
 * code-switching populates `seg.language`.
 */
export function resolveDetectedLanguage(meta: Record<string, unknown> | undefined, seg: EnrichmentSeg): unknown | undefined {
  if (meta?.detected_language !== undefined) return meta.detected_language;
  if (meta?.detectedLanguage !== undefined) return meta.detectedLanguage;
  return seg.language;
}

/**
 * Compose the delivered metadata in the EXACT §5.2 precedence order
 * (lowest → highest), fixing defect F4:
 *   1. v2 ASR/diarization enrichments   — LOWEST (caller may override)
 *   2. caller-supplied correlated meta  — OVERRIDES enrichments
 *   3. v1-canonical normalized keys      — HIGHEST (overlay last, matches v1 §4.3)
 *
 * A caller who sets `speaker_id`/`confidence`/`language`/`isFinal` now sees
 * THEIR value; only `chunk_id`/`detected_language` are overlaid on top.
 */
export function composeDeliveredMetadata(args: {
  seg: EnrichmentSeg;
  isFinal: boolean;
  callerMeta: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const { seg, isFinal, callerMeta } = args;
  const chunkId = resolveChunkId(callerMeta);
  const detectedLanguage = resolveDetectedLanguage(callerMeta, seg);
  return {
    // (1) enrichments — lowest precedence
    speaker_id: seg.speakerLabel,
    confidence: seg.confidence,
    language: seg.language,
    startTime: seg.startTime,
    endTime: seg.endTime,
    isFinal,
    // (2) caller metadata — overrides enrichments (F4 fix)
    ...(callerMeta ?? {}),
    // (3) v1-canonical normalized keys — highest precedence
    ...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
    ...(detectedLanguage !== undefined ? { detected_language: detectedLanguage } : {}),
  };
}

/** A capture-relative metadata timeline entry (E2). */
export interface TimelineEntry {
  atMs: number;
  metadata?: Record<string, unknown>;
}

/** Bounded ring cap (drop-oldest) — matches the frozen contract (~256). */
export const METADATA_TIMELINE_CAP = 256;

/** v1 `MAX_METADATA_BYTES` parity guard. */
export const MAX_METADATA_BYTES = 8192;

/**
 * Correlate a FINAL segment (has stream-relative `startTime` seconds) to caller
 * metadata via the capture-relative timeline (TASK-564 §5.3):
 *  - choose the LATEST entry with `atMs ≤ startTime*1000`;
 *  - if none precedes (or the base is unknown), fall back to the MOST-RECENT
 *    entry (pure sticky — never worse than today's single-bag behavior).
 *
 * TIME BASE (§5.3 RISK): `atMs` is `Date.now() - captureStartMs` (capture-relative
 * wall clock); `startTime` is stream-relative seconds anchored at the same capture
 * start (`vadStreamStartSec`). Both count forward from ~capture start, so the
 * comparison is meaningful. When `captureStartMs`/`startTime` is unknown we degrade
 * to sticky rather than mis-attribute.
 */
export function pickMetadataForFinal(
  timeline: readonly TimelineEntry[],
  startTime: number | undefined,
  captureStartMs: number | undefined,
): Record<string, unknown> | undefined {
  if (timeline.length === 0) return undefined;
  const mostRecent = timeline[timeline.length - 1];
  // Degrade to sticky when we cannot place the segment on the timeline.
  if (captureStartMs === undefined || startTime === undefined) return mostRecent.metadata;
  const targetMs = startTime * 1000;
  let preceding: TimelineEntry | undefined;
  for (const entry of timeline) {
    if (entry.atMs <= targetMs) preceding = entry;
  }
  return (preceding ?? mostRecent).metadata;
}

/** Interims have no reliable `startTime` window → most-recent (sticky). */
export function pickMetadataForInterim(timeline: readonly TimelineEntry[]): Record<string, unknown> | undefined {
  if (timeline.length === 0) return undefined;
  return timeline[timeline.length - 1].metadata;
}

/** Apply the v1 `transcriptTemplate`, defaulting to the v1-parity template. */
export function applyTemplate(template: string | undefined, parts: { text: string; speakerId?: string; timestamp?: string }): string {
  const effective = template || DEFAULT_TRANSCRIPT_TEMPLATE;
  return effective
    .replace(/\{text\}/g, parts.text)
    .replace(/\{speaker_id\}/g, parts.speakerId ?? '')
    .replace(/\{timestamp\}/g, parts.timestamp ?? '');
}
