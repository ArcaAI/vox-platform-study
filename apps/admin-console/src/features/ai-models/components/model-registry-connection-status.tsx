'use client';

import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { useModelRegistryConnectionStatus } from '../api/hooks';

/**
 * Mode U (`sourceUri = s3://...`) fails closed unless the platform's
 * `model-registry`/`s3` provider connection is enabled AND keyed — that row is
 * owned by `features/ai-providers` (rule 13: one authoritative editor per
 * backend resource; `CLOUD_BYO_PROVIDERS['model-registry']` is deliberately
 * empty because this plane is platform-managed, SYSTEM-only). This reads it
 * read-only, off its own minimal-copy client (no cross-feature import — the
 * same posture `features/ai-platform`'s CatalogueTab already uses in
 * reverse), and links out rather than growing a second editor.
 */
export function ModelRegistryConnectionStatus() {
  const status = useModelRegistryConnectionStatus();

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">S3 model registry connection:</span>
      {status.isPending ? (
        <Skeleton className="h-5 w-28 rounded-full" />
      ) : status.error ? (
        <StatusBadge label="Couldn't check" colorRole="neutral" />
      ) : status.data.enabled && status.data.hasKey ? (
        <StatusBadge label="Enabled & keyed" colorRole="success" />
      ) : status.data.enabled ? (
        <StatusBadge label="Enabled, no key" colorRole="warning" />
      ) : (
        <StatusBadge label="Disabled" colorRole="neutral" />
      )}
      <Link
        href="/ai-platform?tab=providers&psvc=model-registry"
        className="text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
      >
        Configure
        <IconExternalLink aria-hidden className="size-3" />
      </Link>
    </div>
  );
}
