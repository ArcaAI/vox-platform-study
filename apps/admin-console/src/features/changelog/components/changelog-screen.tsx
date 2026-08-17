'use client';

import { useState } from 'react';
import { useQueryState } from 'nuqs';
import { HistoryTimelineList, type TimelineItemModel } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { IconFilePlus } from '@tabler/icons-react';
import { useSession } from '@/shared/auth';
import { FilterBar, FilterSearch } from '@/shared/data/filter-bar';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useChangelogList } from '../api/hooks';
import type { ChangelogEntry, ChangelogSeverity } from '../api/types';
import { ChangelogEntryDrawer } from './changelog-entry-drawer';

const SEVERITY_BADGE_VARIANT: Record<ChangelogSeverity, 'destructive' | 'default' | 'secondary'> = {
  BREAKING: 'destructive',
  IMPORTANT: 'default',
  INFO: 'secondary',
};

function toTimelineItem(entry: ChangelogEntry): TimelineItemModel {
  return {
    id: entry.id,
    timestamp: entry.publishedAt ?? new Date(0).toISOString(),
    title: (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{entry.title}</span>
        <span className="text-muted-foreground font-mono text-xs">{entry.platformVersion}</span>
        {entry.publishStatus === 'DRAFT' ? <Badge variant="outline">DRAFT</Badge> : null}
        {!entry.acknowledged ? <Badge variant="secondary">New</Badge> : null}
      </div>
    ),
    variant: 'markdown',
    content: { type: 'markdown', markdown: entry.body },
    badges: [{ label: entry.severity, variant: SEVERITY_BADGE_VARIANT[entry.severity] }],
    defaultExpanded: true,
    meta: { entry },
  };
}

/**
 * `/(console)/(shared)/changelog` — tier 20-29: both global and tenant admins.
 * Reverse-chronological timeline (narrative, not a data grid).
 */
export function ChangelogScreen() {
  const { data: session } = useSession();
  const isSuperAdmin = session?.effectiveUser.roles.includes('SUPER_ADMIN') ?? false;

  const [severity, setSeverity] = useQueryState('severity');
  const [version, setVersion] = useQueryState('version', { defaultValue: '' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isLoading } = useChangelogList({
    severity: (severity as ChangelogSeverity | null) ?? undefined,
    version: version || undefined,
  });

  const entries = data?.data ?? [];

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="What's New"
          meta={<span>{data ? `${data.count} entries` : null}</span>}
          actions={
            isSuperAdmin ? (
              <Button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setDrawerOpen(true);
                }}
              >
                <IconFilePlus className="mr-2 size-4" aria-hidden="true" />
                New entry
              </Button>
            ) : undefined
          }
        />
      }
      toolbar={
        <FilterBar shown={entries.length} total={data?.count}>
          <FilterSearch label="Version" placeholder="Search version…" value={version} onChange={setVersion} />
          <Select value={severity ?? 'ALL'} onValueChange={(value) => setSeverity(value === 'ALL' ? null : value)}>
            <SelectTrigger aria-label="Filter by severity" className="w-40">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All severities</SelectItem>
              <SelectItem value="INFO">Info</SelectItem>
              <SelectItem value="IMPORTANT">Important</SelectItem>
              <SelectItem value="BREAKING">Breaking</SelectItem>
            </SelectContent>
          </Select>
        </FilterBar>
      }
      footer={<StatusFooter start={<span>Release notes</span>} end={<span>{data ? `${data.count} total` : null}</span>} />}
    >
      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconFilePlus aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No release notes yet</EmptyTitle>
            <EmptyDescription>Published changelog entries will appear here.</EmptyDescription>
          </EmptyHeader>
          {isSuperAdmin ? (
            <EmptyContent>
              <Button type="button" onClick={() => setDrawerOpen(true)}>
                New entry
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <HistoryTimelineList
          items={entries}
          order="desc"
          mapItem={toTimelineItem}
          height="100%"
          aria-label="Release notes timeline"
          onItemExpand={(id) => {
            if (isSuperAdmin) {
              setEditingId(id);
              setDrawerOpen(true);
            }
          }}
        />
      )}
      <ChangelogEntryDrawer open={drawerOpen} onOpenChange={setDrawerOpen} entryId={editingId} />
    </ScreenTemplate>
  );
}
