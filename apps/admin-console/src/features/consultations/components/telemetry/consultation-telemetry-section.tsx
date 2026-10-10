'use client';

/**
 * TASK-999 Lane C — per-consultation AI telemetry, mounted below the existing
 * relations summary in the consultation detail drawer. Fetched lazily (the
 * hook is only ever called with a real id, by a component that only mounts
 * while the drawer holding that id is open).
 */

import type { ActivityEntry } from '@arcaai/types';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ErrorState } from '@/shared/state/error-state';
import { useConsultationActivity } from '../../api/activity';
import { useConsultationTelemetry } from '../../api/telemetry';
import { ConsultationTelemetryBlocks, type TelemetryRunFallback } from './telemetry-blocks';

/** The newest AI run per kind from the first activity page (best effort: any failure -> no fallback). */
function runsFromActivity(pages: { items?: unknown }[] | undefined): TelemetryRunFallback {
  const newest = new Map<string, { at: string; run: NonNullable<Extract<ActivityEntry, { entryType: 'item' }>['run']> }>();
  for (const page of pages ?? []) {
    for (const entry of Array.isArray(page.items) ? (page.items as ActivityEntry[]) : []) {
      if (entry.entryType !== 'item' || !entry.run) continue;
      const seen = newest.get(entry.kind);
      if (!seen || entry.occurredAt >= seen.at) newest.set(entry.kind, { at: entry.occurredAt, run: entry.run });
    }
  }
  return { preSummary: newest.get('PRE_SUMMARY')?.run, finalSummary: newest.get('NOTE')?.run };
}

function TelemetrySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}

export function ConsultationTelemetrySection({ consultationId }: { consultationId: string }) {
  const telemetry = useConsultationTelemetry(consultationId);
  // The activity runs already carry model / tokens / duration; they back the telemetry source where
  // it is null (TASK-1059 C-04). A failure there never blocks the telemetry itself.
  const activity = useConsultationActivity(consultationId, { aiRuns: true });

  if (telemetry.isPending) return <TelemetrySkeleton />;

  if (telemetry.isError) {
    // 404-over-403: this tenant cannot see the consultation at all. That is an
    // unavailable surface, not a toast-worthy failure — the drawer itself
    // already loaded the consultation, so this is scoped to the telemetry
    // route specifically (e.g. a narrower ability gate on it).
    if (telemetry.error instanceof GatewayError && telemetry.error.isNotFound) {
      return <p className="text-muted-foreground text-sm">Telemetry is not available for this consultation.</p>;
    }
    return <ErrorState title={'Couldn’t load telemetry'} error={telemetry.error} onRetry={() => void telemetry.refetch()} />;
  }

  return <ConsultationTelemetryBlocks telemetry={telemetry.data} runs={runsFromActivity(activity.data?.pages)} />;
}
