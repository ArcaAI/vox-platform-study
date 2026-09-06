'use client';

import { IconAlertTriangle, IconFileOff, IconPlugConnectedX, IconRefresh, IconServerOff } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { StatCard } from '@arcaai/ui/components/metrics';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEngineArtifacts, useEngineConnection, useEngineDiscovery, useRefreshEngine } from '../api/hooks';
import { MODEL_ARTIFACT_BUCKET } from '../api/client';
import type { DiscoveryEntry, DiscoveryEntryStatus, DiscoveryLoadState, DiscoveryProbe, InferenceEngineProvider } from '../api/types';
import { ENGINE_DESCRIPTORS, type EngineDescriptor } from './engine-meta';

const TAB_VALUES = ['server', 'models', 'artifacts'] as const;

/** Never colour alone (rule 11 §10): every tag carries its own words. */
const STATUS_META: Record<DiscoveryEntryStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  registered: { label: 'Registered', variant: 'outline' },
  discovered: { label: 'Discovered', variant: 'secondary' },
  'registered-missing-on-server': { label: 'Missing on server', variant: 'destructive' },
};

const LOAD_STATE_LABEL: Record<DiscoveryLoadState, string> = {
  loaded: 'Loaded',
  'not-loaded': 'Not loaded',
  unknown: 'Load state unknown',
};

/**
 * The probe outcome as an operator reads it.
 *
 * `skipped` is deliberately NOT collapsed into "unreachable": it means nobody
 * asked, which is a different fact and a different fix.
 */
function probeLabel(probe: DiscoveryProbe | undefined): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' } {
  if (!probe) return { label: 'Not probed', variant: 'outline' };
  if (probe.probeStatus === 'ok') return { label: 'Reachable', variant: 'default' };
  if (probe.probeStatus === 'timeout') return { label: 'Timed out', variant: 'destructive' };
  if (probe.probeStatus === 'skipped') return { label: 'Not probed', variant: 'outline' };
  return { label: 'Unreachable', variant: 'destructive' };
}

/** Which tier of the tenant → SYSTEM cascade answered. Absent means TEXT probed its own service default. */
function connectionSourceLabel(probe: DiscoveryProbe | undefined): string {
  if (probe?.connectionSource === 'tenant') return 'Tenant connection';
  if (probe?.connectionSource === 'system') return 'Platform default (SYSTEM)';
  return 'Service default';
}

function ProbeBanner({ probe, descriptor }: { probe: DiscoveryProbe | undefined; descriptor: EngineDescriptor }) {
  if (probe?.probeStatus === 'ok') return null;
  const { label } = probeLabel(probe);
  return (
    <div
      role="status"
      aria-label="Engine status"
      className="border-destructive/40 bg-destructive/10 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm"
    >
      <span className="text-destructive flex items-center gap-2 font-medium">
        <IconAlertTriangle aria-hidden className="size-4 shrink-0" />
        {label}
      </span>
      {probe?.error ? <span className="text-destructive/90 font-mono text-xs break-all">{probe.error}</span> : null}
      {/* Why this is EXPECTED. Without it, the normal state of both engines
          reads as an outage the operator is meant to act on. */}
      <span className="text-muted-foreground">{descriptor.notDeployedNote}</span>
    </div>
  );
}

function EngineStats({ probe, entries, isLoading }: { probe: DiscoveryProbe | undefined; entries: DiscoveryEntry[]; isLoading: boolean }) {
  const reachable = probe?.probeStatus === 'ok';
  const loaded = entries.filter((entry) => entry.loadState === 'loaded').length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Engine"
        value={isLoading ? null : probeLabel(probe).label}
        accent={isLoading ? 'default' : reachable ? 'success' : 'destructive'}
        isLoading={isLoading}
      />
      <StatCard
        label="Probe latency"
        value={isLoading ? null : typeof probe?.latencyMs === 'number' ? `${probe.latencyMs} ms` : '—'}
        isLoading={isLoading}
      />
      <StatCard label="Models reported" value={isLoading ? null : reachable ? `${loaded}/${entries.length} loaded` : '—'} isLoading={isLoading} />
      {/*
        's CPU-fallback tell. There is NO honest value to put here — the
        accelerator in use is not on any HTTP surface — so the tile says so
        rather than showing a weights format and letting it be misread as one.
*/}
      <StatCard label="Active runtime" value={isLoading ? null : 'Not determinable'} hint="Not exposed over HTTP" isLoading={isLoading} />
    </div>
  );
}

function ModelRow({ entry }: { entry: DiscoveryEntry }) {
  const status = STATUS_META[entry.status];
  const quantization = typeof entry.engineMeta?.['quantization'] === 'string' ? (entry.engineMeta['quantization'] as string) : null;
  const maxContext = typeof entry.engineMeta?.['max_context_length'] === 'number' ? (entry.engineMeta['max_context_length'] as number) : null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-mono text-sm">{entry.modelName}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={status.variant}>{status.label}</Badge>
          <Badge variant="outline">{LOAD_STATE_LABEL[entry.loadState]}</Badge>
          {quantization ? <span className="text-muted-foreground font-mono text-xs">{quantization}</span> : null}
          {maxContext ? <span className="text-muted-foreground font-mono text-xs">{maxContext} ctx</span> : null}
        </span>
      </div>
      {entry.registeredModel ? <span className="text-muted-foreground font-mono text-xs">{entry.registeredModel.slug}</span> : null}
    </li>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-5 w-40 rounded-full" />
          </div>
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-3 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </Card>
  );
}

export interface EngineScreenProps {
  provider: InferenceEngineProvider;
}

/**
 * The self-hosted inference-engine screen — one component, one route per engine
 * (see `engine-meta.ts` for why).
 *
 * READ-ONLY, and that is a decision rather than a stage of completion: the
 * console reports engine state and never mutates the workload. What is
 * deliberately absent is named on the Server tab, in the place an operator would
 * have looked for the button.
 *
 * The unreachable path is the PRIMARY path. Both engines run at zero replicas
 * today, so it gets the page-level banner with the probe error verbatim, an
 * explicit empty state on the model list, and copy saying why that is expected —
 * not a spinner, not a blank grid, and not an error page that implicates the
 * console.
 */
export function EngineScreen({ provider }: EngineScreenProps) {
  const descriptor = ENGINE_DESCRIPTORS[provider];
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('server'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'server';

  const discovery = useEngineDiscovery(provider);
  const connection = useEngineConnection(provider);
  const artifacts = useEngineArtifacts(provider, descriptor.artifactPrefix, tab === 'artifacts');
  const refresh = useRefreshEngine(provider);

  // The gateway read failing is NOT the engine failing, and the two must not
  // look alike: a probe that says "unreachable" is an answer, while a rejected
  // query means the console could not ask at all.
  const gatewayError = discovery.error;
  const probe = discovery.data?.probes.find((entry) => entry.provider === provider) ?? discovery.data?.probes[0];
  const entries = discovery.data?.entries ?? [];
  const reachable = probe?.probeStatus === 'ok';

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'server' ? null : next)}>
      <ScreenTemplate
        header={
          <PageHeader
            title={descriptor.title}
            meta={
              <>
                <span>{descriptor.summary}</span>
                {discovery.data ? (
                  <>
                    <span>&middot;</span>
                    <span>Probed {formatRelativeTime(discovery.data.probedAt)}</span>
                  </>
                ) : null}
              </>
            }
            actions={
              <Button variant="outline" onClick={() => void refresh()} disabled={discovery.isFetching}>
                <IconRefresh aria-hidden />
                Probe now
              </Button>
            }
          />
        }
        stats={<EngineStats probe={probe} entries={entries} isLoading={discovery.isPending} />}
        statusBanner={!gatewayError && discovery.data ? <ProbeBanner probe={probe} descriptor={descriptor} /> : undefined}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="server">Server</TabsTrigger>
            <TabsTrigger value="models">Models on server{reachable ? ` (${entries.length})` : ''}</TabsTrigger>
            <TabsTrigger value="artifacts">Artifacts in MinIO</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<span>{discovery.isFetching && !discovery.isPending ? 'Probing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/ai-models/discovery?provider={provider}
              </span>
            }
          />
        }
      >
        {gatewayError ? (
          <ErrorState title="Couldn’t reach the discovery service" error={gatewayError} onRetry={() => void discovery.refetch()} />
        ) : (
          <>
            <TabsContent value="server">
              <div className="flex flex-col gap-4">
                <DetailCard title="Connection">
                  {connection.isPending ? (
                    <ListSkeleton rows={2} />
                  ) : (
                    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                      <dt className="text-muted-foreground">Endpoint</dt>
                      <dd className="min-w-0 font-mono text-xs break-all">
                        {connection.data?.baseUrl ?? (
                          // `version: 0` is the gateway's "no row yet" placeholder,
                          // and for a keyless self-hosted engine it is the NORMAL
                          // shape — so it gets an explanation, not a blank.
                          <span className="text-muted-foreground font-sans">
                            No connection row — the text service reaches this engine at its own service default.
                          </span>
                        )}
                      </dd>
                      <dt className="text-muted-foreground">Resolved from</dt>
                      <dd>{connectionSourceLabel(probe)}</dd>
                      <dt className="text-muted-foreground">Row state</dt>
                      <dd>
                        <Badge variant={connection.data?.enabled ? 'default' : 'outline'}>
                          {connection.data === undefined
                            ? '—'
                            : connection.data.version === 0
                              ? 'No row'
                              : connection.data.enabled
                                ? 'Enabled'
                                : 'Disabled'}
                        </Badge>
                      </dd>
                      <dt className="text-muted-foreground">Model listing</dt>
                      <dd>{descriptor.listingSurface}</dd>
                    </dl>
                  )}
                </DetailCard>

                <DetailCard title="What this screen deliberately does not do">
                  <ul className="flex flex-col gap-3">
                    {descriptor.omissions.map((omission) => (
                      <li key={omission.title} className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{omission.title}</span>
                        <span className="text-muted-foreground text-sm">{omission.detail}</span>
                      </li>
                    ))}
                  </ul>
                </DetailCard>
              </div>
            </TabsContent>

            <TabsContent value="models">
              {discovery.isPending ? (
                <ListSkeleton />
              ) : !reachable ? (
                <EmptyState
                  icon={IconPlugConnectedX}
                  title="The engine did not answer the probe"
                  description={`No model list could be read, so this is not a claim that the engine serves nothing. ${descriptor.notDeployedNote}`}
                />
              ) : entries.length === 0 ? (
                <EmptyState
                  icon={IconServerOff}
                  title="This engine reported no models"
                  description="The engine answered, and its model list was empty. Nothing is loaded and no registry row targets it."
                />
              ) : (
                <ul className="flex flex-col">
                  {entries.map((entry) => (
                    <ModelRow key={`${entry.provider}:${entry.modelName}`} entry={entry} />
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="artifacts">
              {artifacts.isPending ? (
                <ListSkeleton />
              ) : artifacts.error ? (
                <ErrorState
                  title={`Couldn’t list the ${MODEL_ARTIFACT_BUCKET} bucket`}
                  error={artifacts.error}
                  onRetry={() => void artifacts.refetch()}
                />
              ) : (artifacts.data ?? []).length === 0 ? (
                <EmptyState
                  icon={IconFileOff}
                  title="No weight artifacts under this prefix"
                  description={`Nothing is stored under ${descriptor.artifactPrefix} in the ${MODEL_ARTIFACT_BUCKET} bucket. Uploads are a storage operation — use the storage browser.`}
                />
              ) : (
                <ul className="flex flex-col">
                  {(artifacts.data ?? []).map((artifact) => (
                    <li key={artifact.key} className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
                      <span className="min-w-0 truncate font-mono text-sm">{artifact.key}</span>
                      <span className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
                        <span>{formatBytes(artifact.size)}</span>
                        {artifact.lastModified ? <span>{formatDateTime(artifact.lastModified, 'date')}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </>
        )}
      </ScreenTemplate>
    </Tabs>
  );
}
