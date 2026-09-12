'use client';

import { IconDatabaseOff, IconPlus } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import type { ModelInventoryReport, UnregisteredBucketPrefix } from '../api/types';

/** Human label per discovered layout — `staged` carries no `manifest.json` (TASK-960 Lane C). */
const LAYOUT_LABELS: Record<UnregisteredBucketPrefix['layout'], string> = {
  flat: 'Flat',
  'hf-cache': 'HF cache',
  staged: 'Staged upload',
};

/**
 * `staged` gets its own badge variant (never color alone — the caption below
 * carries the same distinction in text) so an operator can tell a hand-
 * uploaded prefix from one the publish job wrote.
 */
const LAYOUT_BADGE_VARIANT: Record<UnregisteredBucketPrefix['layout'], 'outline' | 'secondary'> = {
  flat: 'outline',
  'hf-cache': 'outline',
  staged: 'secondary',
};

/**
 * "In bucket, not registered" (README §3.4/§3.7): every weight-bearing prefix
 * the last inventory found in `s3://hope-models` that no catalogue row
 * references — manifest-bearing (`flat`/`hf-cache`, written by the publish
 * job) or manifest-less (`staged`, an admin upload, TASK-960). Register opens
 * the form pre-filled with the prefix so the row lands with its bucket
 * identity and the inventory marks it AVAILABLE next run. A `staged` entry
 * has no publish-job version and may have no inferred slug — both are
 * rendered only when present, never as an empty placeholder.
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
                  <Badge variant={LAYOUT_BADGE_VARIANT[item.layout]}>{LAYOUT_LABELS[item.layout]}</Badge>
                  {item.slug ? <span className="text-muted-foreground font-mono text-xs">{item.slug}</span> : null}
                  {item.version ? <span className="text-muted-foreground font-mono text-xs">v{item.version}</span> : null}
                  <span className="text-muted-foreground text-xs">
                    {item.objectCount} objects{item.totalBytes != null ? ` · ${formatBytes(item.totalBytes)}` : ''}
                  </span>
                </span>
                {item.layout === 'staged' ? (
                  <span className="text-muted-foreground text-xs italic">Admin upload — no manifest.json; verified by listing once registered.</span>
                ) : null}
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
