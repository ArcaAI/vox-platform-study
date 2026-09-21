/**
 * Per-consultation AI telemetry (TASK-999 Lane C) — `GET
 * admin/consultations/:id/telemetry`. The console mirrors the gateway's wire
 * shape (frozen contract C-1, TASK-999 README §3.1) as its own interfaces
 * rather than importing `@arcaai/applications`, so this file is the ONLY
 * source of truth for that shape on the console side.
 *
 * The whole point of `Block<T>` is that a block can be legitimately empty for
 * three different reasons, and the pane must say which one rather than ever
 * render a fabricated zero:
 * - `NOT_RECORDED` — the platform never captures this at all.
 * - `NO_ACTIVITY` — captured, but this consultation triggered none of it.
 * - `PRUNED` — it existed and retention removed it (e.g. AgentTrajectoryStep,
 *   pruned nightly).
 */

import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

export type TelemetrySource =
  | 'consultation'
  | 'summary-meta'
  | 'usage-ledger'
  | 'agent-trajectory'
  | 'named-entity'
  | 'audio-recording'
  | 'context-item'
  | 'transcription-job';

export type TelemetryUnavailable = 'NOT_RECORDED' | 'NO_ACTIVITY' | 'PRUNED';

export type Block<T> =
  | { available: true; source: TelemetrySource; data: T }
  | { available: false; source: TelemetrySource | null; reason: TelemetryUnavailable };

/** One LLM call. */
export interface LlmStats {
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
}

/** Many LLM calls, rolled up. */
export interface LlmAggregate {
  callCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Every distinct model seen; may be []. */
  models: string[];
  provider: string | null;
  avgDurationMs: number | null;
  totalDurationMs: number | null;
}

export interface ConsultationTelemetryResponse {
  consultationId: string;
  /** ISO-8601. */
  generatedAt: string;
  session: Block<{ startedAt: string; lastActivityAt: string; durationMs: number }>;
  caseNotes: Block<{ count: number; measuredCount: number; wordCount: number | null; charCount: number | null }>;
  transcription: Block<{
    jobCount: number;
    durationMs: number | null;
    wordCount: number | null;
    charCount: number | null;
    model: string | null;
    provider: string | null;
  }>;
  preSummary: Block<LlmStats>;
  partialSummary: Block<LlmAggregate>;
  finalSummary: Block<LlmStats>;
  ner: Block<{ entityCount: number; byLabel: Record<string, number>; callCount: number; totalDurationMs: number | null }>;
  guardrail: Block<LlmAggregate>;
}

/** Read-only aggregate; cross-tenant id (or a tenant this admin can't see) answers 404. */
export function getConsultationTelemetry(id: string): Promise<ConsultationTelemetryResponse> {
  return getJson(`admin/consultations/${encodeURIComponent(id)}/telemetry`);
}

const telemetryKey = (id: string) => ['consultations', 'telemetry', id] as const;

/** Fetches only once `id` is a real value — call this exactly when the drawer holding it is open. */
export function useConsultationTelemetry(id: string) {
  return useQuery({ queryKey: telemetryKey(id), queryFn: () => getConsultationTelemetry(id), enabled: !!id });
}
