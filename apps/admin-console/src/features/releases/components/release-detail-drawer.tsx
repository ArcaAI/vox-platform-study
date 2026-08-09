'use client';

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';

import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { EmptyState } from '@/shared/state/empty-state';
import { IconGitCommit } from '@tabler/icons-react';

import type { ServiceRelease } from '../api/types';
import { groupChangelog, isUntagged, releaseBadgeLabel, shortSha } from './release-format';

type DrawerTab = 'overview' | 'changes';

function ReleaseMeta({ release }: { release: ServiceRelease }) {
  return (
    <>
      <span className="font-mono" title={release.gitCommitSha}>
        {shortSha(release.gitCommitSha)}
      </span>
      <CopyButton value={release.gitCommitSha} label="Copy commit SHA" />
      <span aria-hidden>&middot;</span>
      <span title={formatDateTime(release.buildAt)}>built {formatRelativeTime(release.buildAt)}</span>
    </>
  );
}

function OverviewTab({ release }: { release: ServiceRelease }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Service</dt>
        <dd className="font-mono">{release.serviceName}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Version</dt>
        <dd>{isUntagged(release) ? <Badge variant="outline">{releaseBadgeLabel(release)}</Badge> : release.version}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Release tag</dt>
        <dd>{release.releaseTag ?? <span className="text-muted-foreground">&mdash; no release tag</span>}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Branch</dt>
        <dd className="font-mono text-xs">{release.gitBranch || '—'}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Commit SHA</dt>
        <dd className="flex items-center gap-1">
          <span className="font-mono text-xs" title={release.gitCommitSha}>
            {shortSha(release.gitCommitSha)}
          </span>
          <CopyButton value={release.gitCommitSha} label="Copy full commit SHA" />
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Built</dt>
        <dd title={formatDateTime(release.buildAt)}>{formatRelativeTime(release.buildAt)}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Image digest</dt>
        <dd className="font-mono text-xs break-all">{release.imageDigest ?? <span className="text-muted-foreground">not yet attached</span>}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-muted-foreground text-xs">Pipeline</dt>
        <dd>
          {release.ciPipelineUrl ? (
            <a href={release.ciPipelineUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              View pipeline
            </a>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function ChangesTab({ release }: { release: ServiceRelease }) {
  const groups = groupChangelog(release.changelog);
  if (groups.length === 0) {
    return (
      <EmptyState icon={IconGitCommit} title="No technical changelog" description="No commits were recorded for this release build." />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.type} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{group.label}</h3>
          <ul className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <li key={item.sha + item.subject} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                {item.breaking ? (
                  <Badge variant="destructive" className="text-[10px]">
                    Breaking
                  </Badge>
                ) : null}
                <span>{item.subject}</span>
                {item.ticket ? <span className="text-muted-foreground text-xs">({item.ticket})</span> : null}
                <span className="text-muted-foreground font-mono text-xs" title={item.sha}>
                  {shortSha(item.sha)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The one console-wide detail surface (§6) for a `ServiceRelease` row —
 * opened from either the Current or History tab. The Changes tab renders the
 * generated technical changelog (§3.5), grouped by Conventional Commit type,
 * each item linking to its ticket when a `TASK-nnn`/`BUG-nnn` scope was
 * extracted. (A per-commit GitLab link is not built here — the frozen
 * contract carries no repo base URL, so we don't invent one; see the ticket
 * README / U7 report for this gap.)
 */
export function ReleaseDetailDrawer({ release, onOpenChange }: { release: ServiceRelease | null; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<DrawerTab>('overview');
  const open = release !== null;

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as DrawerTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={release ? release.serviceName : 'Release'}
        badges={
          release ? (
            <Badge variant={isUntagged(release) ? 'outline' : 'default'} className="font-mono">
              {releaseBadgeLabel(release)}
            </Badge>
          ) : null
        }
        meta={release ? <ReleaseMeta release={release} /> : null}
        tabs={
          release ? (
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="changes">Changes</TabsTrigger>
            </TabsList>
          ) : null
        }
      >
        {!release ? null : (
          <>
            <TabsContent value="overview" className="mt-0">
              <OverviewTab release={release} />
            </TabsContent>
            <TabsContent value="changes" className="mt-0">
              <Separator className="mb-4" />
              <ChangesTab release={release} />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
