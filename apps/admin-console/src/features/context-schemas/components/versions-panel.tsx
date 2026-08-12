'use client';

/**
 * Version history tab (TASK-666 scope: "version history with pin / track-
 * latest, and department default"). `ConsultationContextSchemaVersion` rows
 * are immutable (TASK-658) — this panel lists them newest-first and lets an
 * admin pin the schema to any of them (`POST :id/pin`), the rollback path.
 * There is no "track latest" pin-to-null here (unlike `DepartmentAgent`):
 * `publish` always advances the pin itself (TASK-658 D-3), so `pin` exists
 * only to move it back to an older, already-published version.
 */

import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { usePinContextSchemaVersion } from '../api/hooks';
import type { ConsultationContextSchema, ConsultationContextSchemaVersion } from '../api/types';
import { IconHistory } from '@tabler/icons-react';

export function VersionsPanel({
  schema,
  versions,
  isPending,
  error,
  onRetry,
  onChanged,
}: {
  schema: ConsultationContextSchema;
  versions: ConsultationContextSchemaVersion[];
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const pin = usePinContextSchemaVersion();

  function handlePin(versionNumber: number) {
    pin.mutate(
      { id: schema.id, versionNumber },
      {
        onSuccess: () => {
          toast.success(`Pinned to v${versionNumber}`);
          onChanged();
        },
        onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not move the pin.'),
      },
    );
  }

  if (isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={IconHistory}
        title="No published versions yet"
        description="Publish a definition from the Definition tab to create the first version."
      />
    );
  }

  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Discovery serves the PINNED version, never simply the latest — pin an older version to roll back without discarding history.
      </p>
      <ul className="flex flex-col gap-2">
        {sorted.map((version) => {
          const isPinned = schema.pinnedVersionNumber === version.versionNumber;
          return (
            <li key={version.id}>
              <Card className="flex-row items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">v{version.versionNumber}</span>
                    {isPinned ? <Badge>Pinned</Badge> : null}
                    <span className="text-muted-foreground text-xs">{version.definition.kinds.length} kind(s)</span>
                  </div>
                  {version.changeReason ? <p className="text-muted-foreground truncate text-xs">{version.changeReason}</p> : null}
                  <span className="text-muted-foreground font-mono text-xs">{new Date(version.createdAt).toLocaleString()}</span>
                </div>
                {!isPinned ? (
                  <Button type="button" variant="outline" size="sm" disabled={pin.isPending} onClick={() => handlePin(version.versionNumber)}>
                    {pin.isPending ? <Spinner /> : null}
                    Pin
                  </Button>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
