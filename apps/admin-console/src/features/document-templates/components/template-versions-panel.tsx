'use client';

/**
 * Version history tab. `DocumentTemplateVersion` rows are immutable — not by
 * convention but by a database trigger that refuses any UPDATE or DELETE
 * (OD-13) — so this panel only ever lists them and moves the PIN.
 *
 * Each non-pinned row shows its server-computed `versionSkew` against the
 * CURRENT pin: a consumer still reading that version keeps working if it says
 * ADDITIVE and is broken if it says BREAKING. That is the same judgement
 * `publish` uses to decide whether a change needs an acknowledgement, surfaced
 * here for an admin deciding whether rolling back is safe.
 */

import { toast } from 'sonner';
import { IconHistory } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { usePinDocumentTemplateVersion } from '../api/hooks';
import type { DocumentTemplate, DocumentTemplateVersion, DocumentTemplateVersionSkew } from '../api/types';

/** Drift-safety badge for a non-pinned version, relative to the current pin. */
function VersionSkewBadge({ skew }: { skew: DocumentTemplateVersionSkew }) {
  if (skew === 'BREAKING') {
    return (
      <Badge variant="outline" className="border-destructive/40 text-destructive">
        Breaking drift
      </Badge>
    );
  }
  if (skew === 'ADDITIVE') {
    return (
      <Badge variant="outline" className="border-success/40 text-success">
        Additive drift — readers still work
      </Badge>
    );
  }
  return <Badge variant="secondary">Identical to pinned</Badge>;
}

export function TemplateVersionsPanel({
  template,
  versions,
  isPending,
  error,
  onRetry,
  onChanged,
}: {
  template: DocumentTemplate;
  versions: DocumentTemplateVersion[];
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const pin = usePinDocumentTemplateVersion();

  function handlePin(versionNumber: number) {
    pin.mutate(
      { id: template.id, versionNumber },
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
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) return <ErrorState error={error} onRetry={onRetry} />;

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={IconHistory}
        title="No published versions yet"
        description="Publish a shape from the Shape tab to create the first version. Until then this template cannot be served."
      />
    );
  }

  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Generation serves the PINNED version, never simply the latest — pin an older version to roll back without discarding history.
      </p>
      <ul className="flex flex-col gap-2">
        {sorted.map((version) => {
          const isPinned = template.pinnedVersionNumber === version.versionNumber;
          const sectionCount = Array.isArray(version.shape?.sections) ? version.shape.sections.length : 0;
          return (
            <li key={version.id}>
              <Card className="flex-row items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">v{version.versionNumber}</span>
                    {isPinned ? <Badge>Pinned</Badge> : version.versionSkew ? <VersionSkewBadge skew={version.versionSkew} /> : null}
                    <span className="text-muted-foreground text-xs">
                      {sectionCount} section{sectionCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  {version.changeReason ? <p className="text-muted-foreground truncate text-xs">{version.changeReason}</p> : null}
                  <span className="text-muted-foreground font-mono text-xs">{new Date(version.createdAt).toLocaleString()}</span>
                </div>
                {!isPinned ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pin.isPending}
                    onClick={() => handlePin(version.versionNumber)}
                    aria-label={`Pin version ${version.versionNumber}`}
                  >
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
