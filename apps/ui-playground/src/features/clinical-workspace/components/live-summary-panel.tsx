/**
 * LiveSummaryPanel (TASK-330 P3, WS4; structured S/O/A/P — TASK-339 FU1).
 *
 * Presentational view of the live-summary SSE stream: the running summary as a
 * structured SOAP note (Subjective / Objective / Assessment / Plan), each
 * section rendered with its own inline medical-entity highlights at the exact
 * character offsets the panel actually renders, annotated with type +
 * confidence, plus a type legend. Sections not yet populated show a skeleton
 * placeholder. Kept prop-driven (no SSE/SDK runtime) so it renders
 * deterministically in tests; `useLiveSummaryStream` feeds it in the cockpit.
 */
import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Activity, AlertCircle, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { buildSoapSectionViews } from '../lib/live-summary';
import type { LiveSummaryEvent } from '../types';
import type { LiveSummaryStreamStatus } from '../hooks/use-live-summary-stream';

interface LiveSummaryPanelProps {
  event: LiveSummaryEvent | null;
  status: LiveSummaryStreamStatus;
  error?: string | null;
  lastUpdatedAt?: string | null;
}

/** Tailwind tone per entity category (best-effort; falls back to a neutral tone). */
const ENTITY_TONE: Record<string, string> = {
  PROBLEM: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30',
  DIAGNOSIS: 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30',
  MEDICATION: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30',
  TREATMENT: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30',
  TEST: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  PROCEDURE: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30',
  ANATOMY: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
};

function toneFor(type: string): string {
  return ENTITY_TONE[type.toUpperCase()] ?? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30';
}

function confidencePercent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function statusMeta(status: LiveSummaryStreamStatus): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  switch (status) {
    case 'open':
      return { label: 'Live', variant: 'default' };
    case 'connecting':
      return { label: 'Connecting…', variant: 'secondary' };
    case 'closed':
      return { label: 'Finalized', variant: 'outline' };
    case 'error':
      return { label: 'Disconnected', variant: 'destructive' };
    default:
      return { label: 'Idle', variant: 'secondary' };
  }
}

export function LiveSummaryPanel({ event, status, error, lastUpdatedAt }: LiveSummaryPanelProps) {
  const meta = statusMeta(status);

  const sectionViews = useMemo(() => {
    if (!event) return [];
    const sections =
      event.sections.length > 0 ? event.sections : event.runningSummary ? [{ title: 'Running Summary', content: event.runningSummary }] : [];
    return buildSoapSectionViews(event.runningSummary, sections, event.entities);
  }, [event]);

  const distinctEntityTypes = useMemo(() => {
    if (!event) return [];
    return Array.from(new Set(event.entities.map((e) => e.type.toUpperCase())));
  }, [event]);

  const hasContent = sectionViews.length > 0;

  return (
    <Card className="flex h-full flex-col" data-testid="live-summary-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-violet-500" />
          Live summary
        </CardTitle>
        <div className="flex items-center gap-2">
          {lastUpdatedAt && status === 'open' && (
            <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
              <Activity className="size-3" />
              updating
            </span>
          )}
          <Badge variant={meta.variant} data-testid="live-summary-status">
            {meta.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {status === 'error' ? (
          <div className="text-destructive flex items-center gap-2 text-sm" data-testid="live-summary-error">
            <AlertCircle className="size-4 shrink-0" />
            {error ?? 'Live summary stream disconnected'}
          </div>
        ) : !event && status === 'connecting' ? (
          <div className="space-y-2" data-testid="live-summary-skeleton">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : !hasContent ? (
          <p className="text-muted-foreground text-sm" data-testid="live-summary-empty">
            Listening… a structured S/O/A/P summary with recognised medical terms will appear here as the visit progresses.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 pr-3">
              <div className="space-y-3" data-testid="live-summary-sections">
                {sectionViews.map((view) => (
                  <div key={view.title} data-testid="live-summary-section" data-section-title={view.title}>
                    <h4 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{view.title}</h4>
                    {view.populated ? (
                      <p className="mt-0.5 text-sm leading-relaxed" data-testid="section-content">
                        {view.segments.map((segment, index) =>
                          segment.entity ? (
                            <mark
                              key={index}
                              data-testid="entity-highlight"
                              data-entity-type={segment.entity.type}
                              data-entity-start={segment.entity.start}
                              data-entity-end={segment.entity.end}
                              title={`${segment.entity.type} · ${confidencePercent(segment.entity.confidence)}% confidence`}
                              className={`rounded px-0.5 ring-1 ring-inset ${toneFor(segment.entity.type)}`}
                            >
                              {segment.text}
                            </mark>
                          ) : (
                            <span key={index}>{segment.text}</span>
                          ),
                        )}
                      </p>
                    ) : (
                      <div className="mt-1" data-testid="section-empty">
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {distinctEntityTypes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-t pt-3" data-testid="entity-legend">
                  {distinctEntityTypes.map((type) => (
                    <Badge key={type} variant="outline" className={`text-[10px] ring-1 ring-inset ${toneFor(type)}`}>
                      {type}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
