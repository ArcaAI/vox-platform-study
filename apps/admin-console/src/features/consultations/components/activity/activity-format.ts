import type { ActivityKind } from '@arcaai/types';
import { formatNumber } from '@/shared/format';

const EM_DASH = '—';

export const KIND_LABEL: Record<ActivityKind, string> = {
  TRANSCRIPT_SEGMENT: 'Transcript segment',
  FULL_TRANSCRIPT: 'Full transcript',
  NOTE: 'Note',
  PRE_SUMMARY: 'Pre-summary',
  CASE_NOTE: 'Case note',
  ATTACHMENT: 'Attachment',
  RECORDING: 'Recording',
  FACT_LEDGER: 'Fact ledger',
  ENCOUNTER_RECAP: 'Encounter recap',
  STRUCTURED: 'Structured data',
  FEEDBACK: 'Feedback',
  LIFECYCLE: 'Lifecycle',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as ActivityKind] ?? kind;
}

/** `encounter_appended` -> `Encounter appended`. */
export function humanizeEventType(type: string): string {
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : type;
}

/** 2400 -> `2.4 s`, 85000 -> `1m 25s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

/** 11_100_000 -> `3h 05m`; under an hour `42m`; a day or more `1d 2h`. */
export function formatGap(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Sub-cent run costs keep four decimals (`$0.0078`); null is unknown, not zero. */
export function formatRunCost(micros: number | null | undefined): string {
  if (micros === null || micros === undefined || Number.isNaN(micros)) return EM_DASH;
  return costFormat.format(micros / 1_000_000);
}

export function formatTokenPair(tokensIn: number, tokensOut: number): string {
  return `${formatNumber(tokensIn)} / ${formatNumber(tokensOut)}`;
}

/** Milliseconds into the recording as `m:ss`. */
export function formatRecordingOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
