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
import type { RunSummary } from '@arcaai/types';
import { formatDateTime, formatNumber } from '@/shared/format';
import type { Block, ConsultationTelemetryResponse, LlmAggregate, LlmStats, TelemetryUnavailable } from '../../api/telemetry';

/** What an unmeasured field says. Never an empty cell, never a zero. */
const NOT_RECORDED = 'not recorded';

/**
 * The activity feed's AI runs that stand in for the telemetry source where it is null (TASK-1059
 * C-04). `preSummary` is the newest PRE_SUMMARY item's run, `finalSummary` the newest NOTE's.
 */
export interface TelemetryRunFallback {
  preSummary?: RunSummary;
  finalSummary?: RunSummary;
}

const UNAVAILABLE_REASON_TEXT: Record<TelemetryUnavailable, string> = {
  NOT_RECORDED: 'not recorded by the platform',
  NO_ACTIVITY: 'no activity for this consultation',
  PRUNED: 'beyond the telemetry retention window',
};

/** ms as "123 ms" — "not recorded" for null, never a bare "0 ms" (0 is a real, measured value). */
function formatMs(value: number | null): string {
  return value === null ? NOT_RECORDED : `${formatNumber(value)} ms`;
}

function formatOrDash(value: string | null): string {
  return value === null || value === '' ? NOT_RECORDED : value;
}

/** "2m 14s" / "9s" — the one place a long-form duration is needed (session length). */
function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

/** A count: "not recorded" for null (formatNumber's own dash is a blank to a reader). */
function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_RECORDED : formatNumber(value);
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

/** The stats of one LLM call, each null field filled from the activity run when there is one. */
function withRunFallback(stats: LlmStats | null, run: RunSummary | undefined): LlmStats {
  return {
    inputTokens: stats?.inputTokens ?? run?.tokensIn ?? null,
    outputTokens: stats?.outputTokens ?? run?.tokensOut ?? null,
    model: stats?.model ?? run?.model ?? null,
    provider: stats?.provider ?? run?.provider ?? null,
    durationMs: stats?.durationMs ?? run?.durationMs ?? null,
  };
}

function LlmStatsView({ stats }: { stats: LlmStats }) {
  return (
    <StatGrid>
      <StatRow label="input tok">{formatCount(stats.inputTokens)}</StatRow>
      <StatRow label="output tok">{formatCount(stats.outputTokens)}</StatRow>
      <StatRow label="model">{formatOrDash(stats.model)}</StatRow>
      <StatRow label="provider">{formatOrDash(stats.provider)}</StatRow>
      <StatRow label="duration">{formatMs(stats.durationMs)}</StatRow>
    </StatGrid>
  );
}

function LlmAggregateView({ agg }: { agg: LlmAggregate }) {
  return (
    <StatGrid>
      <StatRow label="calls">{formatCount(agg.callCount)}</StatRow>
      <StatRow label="input tok">{formatCount(agg.inputTokens)}</StatRow>
      <StatRow label="output tok">{formatCount(agg.outputTokens)}</StatRow>
      <StatRow label="models">{agg.models.length > 0 ? agg.models.join(', ') : 'none'}</StatRow>
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
      <StatRow label="case notes">{formatCount(data.count)}</StatRow>
      <StatRow label="measured">{formatCount(data.measuredCount)}</StatRow>
      <StatRow label="words">{formatCount(data.wordCount)}</StatRow>
      <StatRow label="characters">{formatCount(data.charCount)}</StatRow>
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
      <StatRow label="jobs">{formatCount(data.jobCount)}</StatRow>
      <StatRow label="duration">{formatMs(data.durationMs)}</StatRow>
      <StatRow label="words">{formatCount(data.wordCount)}</StatRow>
      <StatRow label="characters">{formatCount(data.charCount)}</StatRow>
      <StatRow label="model">{formatOrDash(data.model)}</StatRow>
      <StatRow label="provider">{formatOrDash(data.provider)}</StatRow>
    </StatGrid>
  );
}

function NerView({ data }: { data: { entityCount: number; byLabel: Record<string, number>; callCount: number; totalDurationMs: number | null } }) {
  const labels = Object.entries(data.byLabel);
  return (
    <StatGrid>
      <StatRow label="entities">{formatCount(data.entityCount)}</StatRow>
      <StatRow label="by label">{labels.length > 0 ? labels.map(([label, count]) => `${label} (${formatNumber(count)})`).join(', ') : 'none'}</StatRow>
      <StatRow label="calls">{formatCount(data.callCount)}</StatRow>
      <StatRow label="total duration">{formatMs(data.totalDurationMs)}</StatRow>
    </StatGrid>
  );
}

/** A single-call LLM block; an empty or partly null block falls back to the activity run's figures. */
function LlmStatsSection({ title, block, run }: { title: string; block: Block<LlmStats>; run: RunSummary | undefined }) {
  if (!block.available && run) {
    return (
      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <LlmStatsView stats={withRunFallback(null, run)} />
        <p className="text-muted-foreground text-xs">from the consultation activity run</p>
      </section>
    );
  }
  return <BlockSection title={title} block={block} render={(stats) => <LlmStatsView stats={withRunFallback(stats, run)} />} />;
}

/** All eight telemetry sections, in the order the owner asked for them. */
export function ConsultationTelemetryBlocks({ telemetry, runs }: { telemetry: ConsultationTelemetryResponse; runs?: TelemetryRunFallback }) {
  return (
    <div className="flex flex-col gap-4">
      <BlockSection title="Session" block={telemetry.session} render={(data) => <SessionView data={data} />} />
      <BlockSection title="Case notes" block={telemetry.caseNotes} render={(data) => <CaseNotesView data={data} />} />
      <BlockSection title="Transcription" block={telemetry.transcription} render={(data) => <TranscriptionView data={data} />} />
      <LlmStatsSection title="Pre-summary" block={telemetry.preSummary} run={runs?.preSummary} />
      <BlockSection title="Partial (live) summary" block={telemetry.partialSummary} render={(agg) => <LlmAggregateView agg={agg} />} />
      <LlmStatsSection title="Final summary" block={telemetry.finalSummary} run={runs?.finalSummary} />
      <BlockSection title="NER / entities" block={telemetry.ner} render={(data) => <NerView data={data} />} />
      <BlockSection title="Guardrail" block={telemetry.guardrail} render={(agg) => <LlmAggregateView agg={agg} />} />
    </div>
  );
}
