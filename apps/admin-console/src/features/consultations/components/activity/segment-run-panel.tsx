'use client';

import { IconX } from '@tabler/icons-react';
import type { ActivityItemEntry, ActivitySegmentRunEntry } from '@arcaai/types';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useSegmentRun } from '../../api';
import { formatRecordingOffset } from './activity-format';

/** Expands one collapsed run of consecutive segments; each segment opens its own version history. */
export function SegmentRunPanel({
  consultationId,
  run,
  onSelectItem,
  onClose,
}: {
  consultationId: string;
  run: ActivitySegmentRunEntry;
  onSelectItem: (itemId: string) => void;
  onClose: () => void;
}) {
  const segments = useSegmentRun(consultationId, run);
  const items = (segments.data?.pages.flatMap((page) => page.items) ?? []).filter((entry): entry is ActivityItemEntry => entry.entryType === 'item');
  return (
    <section
      aria-label="Transcript segments"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="bg-card flex min-h-0 flex-col overflow-y-auto rounded-md border"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          Segments #{run.firstSeq}
          {'–'}#{run.lastSeq}
        </h2>
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close transcript segments" onClick={onClose}>
          <IconX aria-hidden />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5 px-4 py-3">
        {segments.isPending ? (
          Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)
        ) : segments.isError ? (
          <ErrorState title={'Couldn’t load these segments'} error={segments.error} onRetry={() => void segments.refetch()} />
        ) : (
          <ol className="flex flex-col gap-1.5">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelectItem(item.id)}
                  className="hover:bg-accent focus-visible:ring-ring flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="text-muted-foreground w-24 shrink-0 font-mono text-xs tabular-nums">
                    #{item.segment?.seq ?? '?'} {'·'} {formatRecordingOffset(item.segment?.t0Ms ?? 0)}
                  </span>
                  {item.segment?.speaker ? <span className="text-muted-foreground w-16 shrink-0 text-xs font-semibold">{item.segment.speaker}</span> : null}
                  <span className="min-w-0 flex-1">{item.latestVersion.content}</span>
                  {item.edited ? <span className="text-xs font-semibold">edited</span> : null}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
