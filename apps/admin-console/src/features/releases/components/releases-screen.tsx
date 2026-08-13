'use client';

import { useMemo, useState } from 'react';
import { IconVersions } from '@tabler/icons-react';

import { MetricTable, StatCard } from '@arcaai/ui/components/metrics';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';

import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { CopyButton } from '@/shared/copy-button';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner } from '@/shared/state/error-state';

import { useCurrentReleases, useServiceReleases } from '../api/hooks';
import type { CurrentService, Environment, ServiceRelease } from '../api/types';
import { ReleaseDetailDrawer } from './release-detail-drawer';
import { derivePlatformVersion, driftedServices, oldestBuildAt, releaseBadgeLabel } from './release-format';

const ENVIRONMENTS: Environment[] = ['dev', 'staging', 'prod'];

type ReleasesTab = 'current' | 'history';

function EnvironmentSwitcher({ value, onChange }: { value: Environment; onChange: (next: Environment) => void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as Environment)}>
      <SelectTrigger aria-label="Environment" className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ENVIRONMENTS.map((env) => (
          <SelectItem key={env} value={env}>
            {env}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function VersionBadge({ release }: { release: ServiceRelease }) {
  return (
    <Badge variant={release.releaseTag === null ? 'outline' : 'default'} className="font-mono">
      {releaseBadgeLabel(release)}
    </Badge>
  );
}

function LivenessBadge({ liveness }: { liveness: CurrentService['liveness'] }) {
  return <Badge variant={liveness === 'live' ? 'default' : 'destructive'}>{liveness}</Badge>;
}

function ShaCell({ release }: { release: ServiceRelease }) {
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-xs" title={release.gitCommitSha}>
        {release.gitCommitSha.slice(0, 8)}
      </span>
      <CopyButton value={release.gitCommitSha} label={`Copy commit SHA for ${release.serviceName}`} />
    </span>
  );
}

function ServiceCell({ serviceName, onClick }: { serviceName: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-primary font-medium underline-offset-2 hover:underline focus-visible:underline"
    >
      {serviceName}
    </button>
  );
}

function StatsStrip({ current, isLoading }: { current: CurrentService[]; isLoading: boolean }) {
  const platformVersion = derivePlatformVersion(current);
  const drifted = driftedServices(current);
  const oldest = oldestBuildAt(current);
  const liveCount = current.filter((entry) => entry.liveness === 'live').length;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Platform version" value={platformVersion ?? '—'} isLoading={isLoading} />
      <StatCard label="Services live" value={isLoading ? null : `${liveCount}/${current.length}`} isLoading={isLoading} />
      <StatCard
        label="Services drifted"
        value={isLoading ? null : String(drifted.length)}
        accent={drifted.length > 0 ? 'destructive' : 'default'}
        isLoading={isLoading}
      />
      <StatCard label="Oldest build age" value={isLoading ? null : oldest ? formatRelativeTime(oldest) : '—'} isLoading={isLoading} />
    </div>
  );
}

/**
 * Platform Releases (`/(console)/(global)/releases`, tier 10-19). What version
 * of each service is running, which build produced it, and the technical
 * changelog behind it. Read-only observability — no rollback or
 * promotion actions here.
 */
export function ReleasesScreen() {
  const [environment, setEnvironment] = useState<Environment>('dev');
  const [tab, setTab] = useState<ReleasesTab>('current');
  const [historyService, setHistoryService] = useState<string | undefined>(undefined);
  const [selectedRelease, setSelectedRelease] = useState<ServiceRelease | null>(null);

  const current = useCurrentReleases(environment);
  const history = useServiceReleases({ environment, serviceName: historyService, limit: 50 });

  const currentRows = useMemo(() => current.data ?? [], [current.data]);
  const historyRows = history.data?.data ?? [];
  const drifted = driftedServices(currentRows);
  const platformVersion = derivePlatformVersion(currentRows);

  const serviceOptions = useMemo(() => {
    const names = new Set(currentRows.map((entry) => entry.serviceName));
    return [...names].sort();
  }, [currentRows]);

  const currentTableRows = currentRows.map((entry) => ({
    service: <ServiceCell serviceName={entry.serviceName} onClick={() => setSelectedRelease(entry.release)} />,
    version: <VersionBadge release={entry.release} />,
    releaseTag: entry.release.releaseTag ?? <span className="text-muted-foreground">&mdash;</span>,
    branch: <span className="font-mono text-xs">{entry.release.gitBranch || '—'}</span>,
    sha: <ShaCell release={entry.release} />,
    built: <span title={formatDateTime(entry.release.buildAt)}>{formatRelativeTime(entry.release.buildAt)}</span>,
    runningSince: <span title={formatDateTime(entry.startedAt)}>{formatRelativeTime(entry.startedAt)}</span>,
    instances: String(entry.instanceCount),
    liveness: <LivenessBadge liveness={entry.liveness} />,
  }));

  const historyTableRows = historyRows.map((release) => ({
    service: <ServiceCell serviceName={release.serviceName} onClick={() => setSelectedRelease(release)} />,
    version: <VersionBadge release={release} />,
    releaseTag: release.releaseTag ?? <span className="text-muted-foreground">&mdash;</span>,
    branch: <span className="font-mono text-xs">{release.gitBranch || '—'}</span>,
    sha: <ShaCell release={release} />,
    built: <span title={formatDateTime(release.buildAt)}>{formatRelativeTime(release.buildAt)}</span>,
    pipeline: release.ciPipelineUrl ? (
      <a href={release.ciPipelineUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
        Pipeline
      </a>
    ) : (
      <span className="text-muted-foreground">&mdash;</span>
    ),
  }));

  return (
    <>
      <Tabs value={tab} onValueChange={(next) => setTab(next as ReleasesTab)}>
      <ScreenTemplate
        header={
          <PageHeader
            title="Platform Releases"
            meta={
              <>
                {current.isPending ? (
                  <Skeleton className="h-5 w-24 rounded-full" />
                ) : (
                  <Badge variant={platformVersion ? 'default' : 'outline'} className="font-mono">
                    {platformVersion ? `ALL-${platformVersion}` : 'no ALL- train tag'}
                  </Badge>
                )}
              </>
            }
            actions={<EnvironmentSwitcher value={environment} onChange={setEnvironment} />}
          />
        }
        stats={<StatsStrip current={currentRows} isLoading={current.isPending} />}
        statusBanner={
          drifted.length > 0 ? (
            <ErrorBanner
              error={new Error(`${drifted.length} service${drifted.length === 1 ? '' : 's'} in ${environment} have no live instance.`)}
              onRetry={() => void current.refetch()}
            />
          ) : undefined
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="current">Current</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<span>{current.isFetching && !current.isPending ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/service-releases
              </span>
            }
          />
        }
      >
          <TabsContent value="current" className="mt-0">
            <MetricTable
              columns={[
                { key: 'service', label: 'Service' },
                { key: 'version', label: 'Version' },
                { key: 'releaseTag', label: 'Release tag' },
                { key: 'branch', label: 'Branch' },
                { key: 'sha', label: 'SHA' },
                { key: 'built', label: 'Built' },
                { key: 'runningSince', label: 'Running since' },
                { key: 'instances', label: 'Instances', format: 'numeric' },
                { key: 'liveness', label: 'Status' },
              ]}
              rows={currentTableRows}
              zebra
              aria-label="Current releases"
              isLoading={current.isPending}
              error={current.error ?? undefined}
              emptyState={
                <EmptyState
                  icon={IconVersions}
                  title="No services registered"
                  description={`No service has registered a release in ${environment} yet.`}
                />
              }
            />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <div className="mb-3 flex items-center gap-2">
              <Select value={historyService ?? '__all__'} onValueChange={(next) => setHistoryService(next === '__all__' ? undefined : next)}>
                <SelectTrigger aria-label="Filter by service" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All services</SelectItem>
                  {serviceOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <MetricTable
              columns={[
                { key: 'service', label: 'Service' },
                { key: 'version', label: 'Version' },
                { key: 'releaseTag', label: 'Release tag' },
                { key: 'branch', label: 'Branch' },
                { key: 'sha', label: 'SHA' },
                { key: 'built', label: 'Built' },
                { key: 'pipeline', label: 'Pipeline' },
              ]}
              rows={historyTableRows}
              zebra
              aria-label="Release history"
              isLoading={history.isPending}
              error={history.error ?? undefined}
              emptyState={
                <EmptyState icon={IconVersions} title="No release history" description="No builds have registered for this filter yet." />
              }
            />
          </TabsContent>
      </ScreenTemplate>
      </Tabs>
      <ReleaseDetailDrawer release={selectedRelease} onOpenChange={(open) => !open && setSelectedRelease(null)} />
    </>
  );
}

/** Mirrors the loaded layout (rule 10) — header, stats, tabs and table skeletons. */
export function ReleasesScreenSkeleton() {
  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Platform Releases"
          meta={<Skeleton className="h-5 w-24 rounded-full" />}
          actions={<Skeleton className="h-9 w-32" />}
        />
      }
      stats={
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      }
      footer={<StatusFooter start={<Skeleton className="h-4 w-20" />} />}
    >
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </ScreenTemplate>
  );
}
