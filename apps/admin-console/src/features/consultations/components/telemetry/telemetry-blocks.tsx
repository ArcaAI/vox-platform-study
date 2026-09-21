'use client';

/**
 * TASK-999 Lane C — render primitives for the eight `Block<T>` sections of
 * `ConsultationTelemetryResponse` (contract C-1). House style copied from
 * `features/ai-operations-runs/components/step-stats.tsx`: a mono/tabular-nums
 * `dl` in a bordered `bg-muted/30` box.
 *
 * The one rule every renderer here obeys: a `null` field inside an
 * `available: true` block is an em dash, NEVER a zero — a summary that cost
 * nothing and a summary nobody measured must never look the same.
 */

import type { ReactNode } from 'react';
import { formatDateTime, formatNumber } from '@/shared/format';
import type { Block, ConsultationTelemetryResponse, LlmAggregate, LlmStats, TelemetryUnavailable } from '../../api/telemetry';

const EM_DASH = '—';

const UNAVAILABLE_REASON_TEXT: Record<TelemetryUnavailable, string> = {
  NOT_RECORDED: 'not recorded by the platform',
  NO_ACTIVITY: 'no activity for this consultation',
  PRUNED: 'beyond the telemetry retention window',
};

/** ms as "123 ms" — an em dash for null, never a bare "0 ms" (0 is a real, measured value). */
function formatMs(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value)} ms`;
}

function formatOrDash(value: string | null): string {
  return value === null || value === '' ? EM_DASH : value;
}

/** "2m 14s" / "9s" — the one place a long-form duration is needed (session length). */
function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function StatRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground font-mono text-xs">{label}</dt>
      <dd className="font-mono text-xs tabular-nums">{children}</dd>
    </>
  );
}

function StatGrid({ children }: { children: ReactNode }) {
  return <dl className="bg-muted/30 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border p-2">{children}</dl>;
}

/** The one place the three "why is this empty" reasons render. */
export function UnavailableNote({ reason }: { reason: TelemetryUnavailable }) {
  return <p className="text-muted-foreground text-xs">{UNAVAILABLE_REASON_TEXT[reason]}</p>;
}

function BlockSection<T>({ title, block, render }: { title: string; block: Block<T>; render: (data: T) => ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {block.available ? render(block.data) : <UnavailableNote reason={block.reason} />}
    </section>
  );
}

function LlmStatsView({ stats }: { stats: LlmStats }) {
  return (
    <StatGrid>
      <StatRow label="input tok">{formatNumber(stats.inputTokens)}</StatRow>
      <StatRow label="output tok">{formatNumber(stats.outputTokens)}</StatRow>
      <StatRow label="model">{formatOrDash(stats.model)}</StatRow>
      <StatRow label="provider">{formatOrDash(stats.provider)}</StatRow>
      <StatRow label="duration">{formatMs(stats.durationMs)}</StatRow>
    </StatGrid>
  );
}

function LlmAggregateView({ agg }: { agg: LlmAggregate }) {
  return (
    <StatGrid>
      <StatRow label="calls">{formatNumber(agg.callCount)}</StatRow>
      <StatRow label="input tok">{formatNumber(agg.inputTokens)}</StatRow>
      <StatRow label="output tok">{formatNumber(agg.outputTokens)}</StatRow>
      <StatRow label="models">{agg.models.length > 0 ? agg.models.join(', ') : EM_DASH}</StatRow>
      <StatRow label="provider">{formatOrDash(agg.provider)}</StatRow>
      <StatRow label="avg duration">{formatMs(agg.avgDurationMs)}</StatRow>
      <StatRow label="total duration">{formatMs(agg.totalDurationMs)}</StatRow>
    </StatGrid>
  );
}

function SessionView({ data }: { data: { startedAt: string; lastActivityAt: string; durationMs: number } }) {
  return (
    <StatGrid>
      <StatRow label="started">{formatDateTime(data.startedAt)}</StatRow>
      <StatRow label="last activity">{formatDateTime(data.lastActivityAt)}</StatRow>
      <StatRow label="duration">{formatDurationLong(data.durationMs)}</StatRow>
    </StatGrid>
  );
}

function CaseNotesView({ data }: { data: { count: number; measuredCount: number; wordCount: number | null; charCount: number | null } }) {
  return (
    <StatGrid>
      <StatRow label="case notes">{formatNumber(data.count)}</StatRow>
      <StatRow label="measured">{formatNumber(data.measuredCount)}</StatRow>
      <StatRow label="words">{formatNumber(data.wordCount)}</StatRow>
      <StatRow label="characters">{formatNumber(data.charCount)}</StatRow>
    </StatGrid>
  );
}

function TranscriptionView({
  data,
}: {
  data: {
    jobCount: number;
    durationMs: number | null;
    wordCount: number | null;
    charCount: number | null;
    model: string | null;
    provider: string | null;
  };
}) {
  return (
    <StatGrid>
      <StatRow label="jobs">{formatNumber(data.jobCount)}</StatRow>
      <StatRow label="duration">{formatMs(data.durationMs)}</StatRow>
      <StatRow label="words">{formatNumber(data.wordCount)}</StatRow>
      <StatRow label="characters">{formatNumber(data.charCount)}</StatRow>
      <StatRow label="model">{formatOrDash(data.model)}</StatRow>
      <StatRow label="provider">{formatOrDash(data.provider)}</StatRow>
    </StatGrid>
  );
}

function NerView({ data }: { data: { entityCount: number; byLabel: Record<string, number>; callCount: number; totalDurationMs: number | null } }) {
  const labels = Object.entries(data.byLabel);
  return (
    <StatGrid>
      <StatRow label="entities">{formatNumber(data.entityCount)}</StatRow>
      <StatRow label="by label">{labels.length > 0 ? labels.map(([label, count]) => `${label} (${formatNumber(count)})`).join(', ') : EM_DASH}</StatRow>
      <StatRow label="calls">{formatNumber(data.callCount)}</StatRow>
      <StatRow label="total duration">{formatMs(data.totalDurationMs)}</StatRow>
    </StatGrid>
  );
}

/** All eight telemetry sections, in the order the owner asked for them. */
export function ConsultationTelemetryBlocks({ telemetry }: { telemetry: ConsultationTelemetryResponse }) {
  return (
    <div className="flex flex-col gap-4">
      <BlockSection title="Session" block={telemetry.session} render={(data) => <SessionView data={data} />} />
      <BlockSection title="Case notes" block={telemetry.caseNotes} render={(data) => <CaseNotesView data={data} />} />
      <BlockSection title="Transcription" block={telemetry.transcription} render={(data) => <TranscriptionView data={data} />} />
      <BlockSection title="Pre-summary" block={telemetry.preSummary} render={(stats) => <LlmStatsView stats={stats} />} />
      <BlockSection title="Partial (live) summary" block={telemetry.partialSummary} render={(agg) => <LlmAggregateView agg={agg} />} />
      <BlockSection title="Final summary" block={telemetry.finalSummary} render={(stats) => <LlmStatsView stats={stats} />} />
      <BlockSection title="NER / entities" block={telemetry.ner} render={(data) => <NerView data={data} />} />
      <BlockSection title="Guardrail" block={telemetry.guardrail} render={(agg) => <LlmAggregateView agg={agg} />} />
    </div>
  );
}
