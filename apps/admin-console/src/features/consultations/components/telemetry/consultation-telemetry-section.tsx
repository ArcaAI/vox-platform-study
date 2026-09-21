'use client';

/**
 * TASK-999 Lane C — per-consultation AI telemetry, mounted below the existing
 * relations summary in the consultation detail drawer. Fetched lazily (the
 * hook is only ever called with a real id, by a component that only mounts
 * while the drawer holding that id is open).
 */

import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ErrorState } from '@/shared/state/error-state';
import { useConsultationTelemetry } from '../../api/telemetry';
import { ConsultationTelemetryBlocks } from './telemetry-blocks';

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

  return <ConsultationTelemetryBlocks telemetry={telemetry.data} />;
}
