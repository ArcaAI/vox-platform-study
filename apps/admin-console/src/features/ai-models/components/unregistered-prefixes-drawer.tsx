'use client';

import { IconDatabaseOff, IconPlus } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import type { ModelInventoryReport, UnregisteredBucketPrefix } from '../api/types';

/**
 * "In bucket, not registered" (README §3.4/§3.7): every manifest-bearing
 * prefix the last inventory found in `s3://hope-models` that no catalogue row
 * references. Register opens the form pre-filled with the prefix so the row
 * lands with its bucket identity and the inventory marks it AVAILABLE next run.
 */
export function UnregisteredPrefixesDrawer({
  open,
  onOpenChange,
  report,
  onRegister,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: ModelInventoryReport | null | undefined;
  onRegister: (prefix: UnregisteredBucketPrefix) => void;
}) {
  const items = report?.unregistered ?? [];
  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="In bucket, not registered"
      meta={report ? <span data-testid="inventory-checked-at">Inventoried {formatRelativeTime(report.checkedAt)}</span> : null}
    >
      {!report ? (
        <EmptyState icon={IconDatabaseOff} title="No inventory yet" description="Run the inventory to list the weights in the bucket that no catalogue row references." />
      ) : items.length === 0 ? (
        <EmptyState icon={IconDatabaseOff} title="Every prefix in the bucket is registered" description="The last inventory found no weights without a catalogue row." />
      ) : (
        <ul className="flex flex-col" aria-label="Unregistered bucket prefixes">
          {items.map((item) => (
            <li key={item.bucketPrefix} className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-sm">{item.bucketPrefix}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{item.layout === 'hf-cache' ? 'HF cache' : 'Flat'}</Badge>
                  {item.slug ? <span className="text-muted-foreground font-mono text-xs">{item.slug}</span> : null}
                  <span className="text-muted-foreground text-xs">
                    {item.objectCount} objects{item.totalBytes != null ? ` · ${formatBytes(item.totalBytes)}` : ''}
                  </span>
                </span>
              </div>
              <Button size="sm" onClick={() => onRegister(item)} aria-label={`Register ${item.bucketPrefix}`}>
                <IconPlus aria-hidden />
                Register
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DetailDrawer>
  );
}
