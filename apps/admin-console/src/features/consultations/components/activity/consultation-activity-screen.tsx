'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconArrowLeft, IconInbox, IconLock } from '@tabler/icons-react';
import { ACTIVITY_KINDS, type ActivityKind, type ActivitySegmentRunEntry, type Aggregates, type EncounterBlock } from '@arcaai/types';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { HistoryTimelineList } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useActivityParams, useConsultationActivity, type ActivityFilters } from '../../api';
import { ConsultationStatusBadge } from '../consultation-status-badge';
import { formatRunCost, kindLabel } from './activity-format';
import { buildActivityRows, isItemEntry, segmentRunRowId } from './activity-model';
import { SegmentRunPanel } from './segment-run-panel';
import { VersionHistoryPanel } from './version-history-panel';

function ActivitySkeleton() {
  return (
    <div role="status" aria-label="Loading consultation activity" className="flex flex-col gap-3">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

function RestrictedCard() {
  return (
    <Card role="note" className="mx-auto flex max-w-lg flex-col items-center gap-3 p-10 text-center">
      <IconLock aria-hidden className="text-muted-foreground size-8" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">Restricted</p>
        <p className="text-muted-foreground text-sm">
          Consultation history includes decrypted patient data, so it is limited to platform and tenant administrators. Your account does not have
          access to it.
        </p>
      </div>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-3.5 py-2.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function StatsStrip({ encounters, aggregates }: { encounters: EncounterBlock[]; aggregates: Aggregates }) {
  return (
    <dl aria-label="Consultation totals" className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
      <Stat label="Encounters">{encounters.length}</Stat>
      <Stat label="AI runs">{formatNumber(aggregates.aiRunCount)}</Stat>
      <Stat label="Tokens in/out">{`${formatNumber(aggregates.tokensIn)} / ${formatNumber(aggregates.tokensOut)}`}</Stat>
      <Stat label="AI cost">{formatRunCost(aggregates.costMicros)}</Stat>
      <Stat label="Edited items">{formatNumber(aggregates.editedItems)}</Stat>
      <Stat label="Feedback">{`${formatNumber(aggregates.feedbackUp)} up / ${formatNumber(aggregates.feedbackDown)} down`}</Stat>
    </dl>
  );
}

function FilterToolbar({
  presentKinds,
  kinds,
  edited,
  aiRuns,
  onKinds,
  onEdited,
  onAiRuns,
}: {
  presentKinds: ActivityKind[];
  kinds: ActivityKind[];
  edited: boolean;
  aiRuns: boolean;
  onKinds: (kinds: ActivityKind[]) => void;
  onEdited: (value: boolean) => void;
  onAiRuns: (value: boolean) => void;
}) {
  const shown = ACTIVITY_KINDS.filter((kind) => presentKinds.includes(kind) || kinds.includes(kind));
  return (
    <div role="group" aria-label="Filter activity" className="flex flex-wrap items-center gap-1.5">
      {shown.map((kind) => {
        const pressed = kinds.includes(kind);
        return (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant={pressed ? 'default' : 'outline'}
            aria-pressed={pressed}
            onClick={() => onKinds(pressed ? kinds.filter((k) => k !== kind) : [...kinds, kind])}
          >
            {kindLabel(kind)}
          </Button>
        );
      })}
      <Button type="button" size="sm" variant={edited ? 'default' : 'outline'} aria-pressed={edited} onClick={() => onEdited(!edited)}>
        Edited only
      </Button>
      <Button type="button" size="sm" variant={aiRuns ? 'default' : 'outline'} aria-pressed={aiRuns} onClick={() => onAiRuns(!aiRuns)}>
        AI runs only
      </Button>
    </div>
  );
}

/**
 * One consultation's activity, oldest first: every item the consultation produced, grouped by
 * encounter with the time away between encounters marked, AI runs annotated on the items they
 * produced. Selecting an item opens its version history beside the timeline (non-modal).
 */
export function ConsultationActivityScreen({ consultationId }: { consultationId: string }) {
  const [params, setParams] = useActivityParams();
  const [segmentRun, setSegmentRun] = useState<ActivitySegmentRunEntry | null>(null);

  const kinds = useMemo(() => params.kinds ?? [], [params.kinds]);
  const filters: ActivityFilters = {
    kinds: kinds.length > 0 ? kinds : undefined,
    edited: params.edited ?? undefined,
    aiRuns: params.aiRuns ?? undefined,
    encounterSeq: params.encounterSeq ?? undefined,
  };
  const feed = useConsultationActivity(consultationId, filters);

  const pages = feed.data?.pages ?? [];
  const first = pages[0];
  const encounters = useMemo(() => {
    const merged = new Map<number, EncounterBlock>();
    for (const page of pages) for (const block of page.encounters) merged.set(block.seq, block);
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages` is rebuilt from `feed.data` every render; keying on the query data keeps the memo stable
  }, [feed.data]);
  const built = useMemo(() => buildActivityRows({ items: pages.flatMap((page) => page.items), encounters }), [feed.data, encounters]); // eslint-disable-line react-hooks/exhaustive-deps -- `pages` derives from `feed.data` (see above)

  const presentKinds = useMemo(() => {
    const present = new Set<ActivityKind>();
    for (const entry of built.entries.values()) if (isItemEntry(entry)) present.add(entry.kind);
    return [...present];
  }, [built]);

  const selectedItemId = params.item;
  const selectedId = selectedItemId ?? (segmentRun ? segmentRunRowId(segmentRun.runId) : null);

  function selectRow(id: string) {
    const entry = built.entries.get(id);
    if (entry?.entryType === 'segment_run') {
      setSegmentRun(entry);
      void setParams({ item: null, v: null });
    } else if (isItemEntry(entry)) {
      setSegmentRun(null);
      void setParams({ item: id, v: null });
    }
  }

  function selectItem(itemId: string, versionNumber?: number) {
    setSegmentRun(null);
    void setParams({ item: itemId, v: versionNumber ?? null });
  }

  function closePanels() {
    setSegmentRun(null);
    void setParams({ item: null, v: null });
  }

  const forbidden = feed.error instanceof GatewayError && feed.error.status === 403;

  let body: React.ReactNode;
  if (feed.isPending) {
    body = <ActivitySkeleton />;
  } else if (forbidden) {
    body = <RestrictedCard />;
  } else if (feed.isError) {
    body = <ErrorState title={'Couldn’t load this consultation’s activity'} error={feed.error} onRetry={() => void feed.refetch()} />;
  } else if (built.rows.length === 0) {
    body = <EmptyState icon={IconInbox} title="No activity yet" description="Items from this consultation will appear here as they are created." />;
  } else {
    const hasPanel = selectedItemId !== null || segmentRun !== null;
    body = (
      <div className={hasPanel ? 'grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'flex min-h-0 flex-1 flex-col'}>
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <HistoryTimelineList
            items={built.rows}
            inputOrder="asc"
            aria-label="Consultation activity, oldest first"
            selectedId={selectedId}
            onItemSelect={selectRow}
            height="calc(100svh - 24rem)"
          />
          {feed.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-center"
              disabled={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              Load more
            </Button>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Showing the latest version of every item. Items are decrypted for this view and the read is audited.
          </p>
        </div>
        {selectedItemId !== null ? (
          <VersionHistoryPanel
            consultationId={consultationId}
            itemId={selectedItemId}
            entry={(() => {
              const entry = built.entries.get(selectedItemId);
              return isItemEntry(entry) ? entry : undefined;
            })()}
            version={params.v}
            onVersionChange={(v) => void setParams({ v })}
            onClose={closePanels}
            onSelectItem={selectItem}
          />
        ) : segmentRun ? (
          <SegmentRunPanel consultationId={consultationId} run={segmentRun} onSelectItem={selectItem} onClose={closePanels} />
        ) : null}
      </div>
    );
  }

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Consultation"
          meta={
            <>
              <span className="font-mono text-xs break-all">{consultationId}</span>
              {first ? <ConsultationStatusBadge status={first.status} processing={first.processing} processingReason={first.processingReason} /> : null}
            </>
          }
          actions={
            <Button asChild variant="outline" size="sm">
              <Link href="/consultations">
                <IconArrowLeft aria-hidden />
                Back to consultations
              </Link>
            </Button>
          }
        />
      }
      stats={first?.aggregates ? <StatsStrip encounters={encounters} aggregates={first.aggregates} /> : undefined}
      toolbar={
        first ? (
          <FilterToolbar
            presentKinds={presentKinds}
            kinds={kinds}
            edited={params.edited ?? false}
            aiRuns={params.aiRuns ?? false}
            onKinds={(next) => void setParams({ kinds: next.length > 0 ? next : null })}
            onEdited={(value) => void setParams({ edited: value || null })}
            onAiRuns={(value) => void setParams({ aiRuns: value || null })}
          />
        ) : undefined
      }
    >
      {body}
    </ScreenTemplate>
  );
}
