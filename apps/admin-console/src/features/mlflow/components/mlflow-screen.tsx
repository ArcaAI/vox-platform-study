'use client';

import { useId, type ReactNode } from 'react';
import { IconAlertTriangle, IconExternalLink, IconPackageOff, IconPlugConnectedX, IconRefresh } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { StatCard } from '@arcaai/ui/components/metrics';
import { formatDateTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useMlflowExperiments, useMlflowModelVersions, useMlflowRegisteredModels, useMlflowStatus, useRefreshMlflow } from '../api/hooks';
import type { MlflowStatus } from '../api/types';

const TAB_VALUES = ['registered-models', 'model-versions', 'experiments', 'access'] as const;

/**
 * MLflow publishes epoch milliseconds as proto int64, which crosses JSON as a
 * STRING more often than a number. Accept both, and render nothing rather than
 * `Invalid Date` when it is neither.
 */
function formatEpochMillis(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const millis = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return formatDateTime(new Date(millis), 'date');
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-5 w-32 rounded-full" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Titled card exposed as a landmark region so each block is addressable. */
function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const uid = useId();
  return (
    <Card className="gap-3 p-4" role="region" aria-labelledby={uid}>
      <div className="flex flex-col gap-0.5">
        <h2 id={uid} className="text-sm font-medium">
          {title}
        </h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}

/**
 * The unreachable banner. MLflow shipped WITHOUT an Ingress and is an opt-in
 * compose profile locally, so "not deployed" is its normal state and the banner
 * says why rather than implying an outage.
 */
function StatusBanner({ status }: { status: MlflowStatus }) {
  if (status.reachable) return null;
  return (
    <div
      role="status"
      aria-label="MLflow status"
      className="border-destructive/40 bg-destructive/10 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm"
    >
      <span className="text-destructive flex items-center gap-2 font-medium">
        <IconAlertTriangle aria-hidden className="size-4 shrink-0" />
        Tracking server not reachable
      </span>
      {status.error ? <span className="text-destructive/90 text-xs">{status.error}</span> : null}
      <span className="text-muted-foreground">
        MLflow is deployed with no Ingress and is an opt-in profile in local development, so an unreachable tracking server is the expected
        state rather than an outage. The gateway reaches it in-cluster at <span className="font-mono text-xs">{status.baseUrl}</span>.
      </span>
    </div>
  );
}

/**
 * The Access tab — where "embed the MLflow interface" is answered honestly.
 *
 * The verdict is NOT hardcoded. `embeddable` is computed by the gateway from
 * the `X-Frame-Options` header OBSERVED on the live probe plus whether a
 * browser-reachable URL is configured, so an operator who sets
 * `MLFLOW_SERVER_X_FRAME_OPTIONS=NONE` and publishes a URL gets a working
 * embedded view here with no code change — and a future MLflow that changes its
 * default is observed rather than mis-reported.
 */
function AccessPanel({ status }: { status: MlflowStatus }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title="Embedding the MLflow interface"
        description="Whether the console may render MLflow in a frame is decided by the live probe, not by a setting in this app."
      >
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">X-Frame-Options observed</dt>
          <dd className="font-mono text-xs">{status.frameOptions ?? 'none sent'}</dd>
          <dt className="text-muted-foreground">Browser-reachable URL</dt>
          <dd className="min-w-0 font-mono text-xs break-all">{status.uiUrl ?? 'not configured'}</dd>
          <dt className="text-muted-foreground">Embeddable</dt>
          <dd>
            <Badge variant={status.embeddable ? 'default' : 'outline'}>{status.embeddable ? 'Yes' : 'No'}</Badge>
          </dd>
        </dl>
        {status.embedBlockedReason ? <p className="text-muted-foreground text-sm">{status.embedBlockedReason}</p> : null}
        {/*
          The blocker that does NOT go away by clearing a header, so it is stated
          separately and permanently: MLflow authenticates nobody. Everything on
          this screen is reachable only because the GATEWAY holds the connection
          and the console's own session governs who may read it.
        */}
        <p className="text-muted-foreground text-sm">
          Note that MLflow has no authentication of its own, and the console session is an httpOnly cookie on this origin that does not
          extend to another. Anything served from an MLflow URL is protected by whatever sits in front of it — not by this console. That is
          why the model, version and experiment data on the other tabs is read through the gateway rather than fetched from the browser.
        </p>
      </SectionCard>

      {status.uiUrl ? (
        <SectionCard title="Open the MLflow interface">
          <div>
            <Button asChild variant="outline">
              <a href={status.uiUrl} target="_blank" rel="noopener noreferrer">
                <IconExternalLink aria-hidden />
                Open MLflow in a new tab
              </a>
            </Button>
          </div>
          {status.embeddable ? (
            <iframe
              title="MLflow interface"
              src={status.uiUrl}
              // A different origin with no authentication of its own: sandbox it,
              // and never hand it this console's URL as a referrer.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
              className="h-[60vh] w-full rounded-md border"
            />
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}

/** One listing panel: unreachable → not-asked, empty → empty, error → retry, else children. */
function ListingPanel({
  reachable,
  isPending,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
}: {
  reachable: boolean;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  children: ReactNode;
}) {
  if (!reachable) {
    return (
      <EmptyState
        icon={IconPlugConnectedX}
        title="The tracking server did not answer"
        description="Nothing was read, so this is not a claim that the registry is empty. Bring MLflow up, then refresh."
      />
    );
  }
  if (isPending) return <ListSkeleton />;
  if (error) return <ErrorState title="Couldn’t read MLflow" error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyState icon={IconPackageOff} title={emptyTitle} description={emptyDescription} />;
  return <>{children}</>;
}

/**
 * MLflow (`/ai-services/mlflow`, tier 10-19, SUPER_ADMIN only).
 *
 * A NATIVE read-only surface over MLflow's own REST verbs, proxied by the
 * gateway — not an iframe. See `AccessPanel` and the gateway's
 * `MlflowProxyClient` header comment for the three independent reasons a frame
 * cannot work today, and for the fact that this screen will render one the
 * moment they are cleared.
 *
 * READ-ONLY by design rather than by omission: `mlflow gc` is MLflow's only
 * hard-delete path and therefore its right-to-erasure mechanism, so deletion
 * belongs to the CronJob that owns it, never to a console button.
 */
export function MlflowScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('registered-models'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'registered-models';

  const status = useMlflowStatus();
  const reachable = status.data?.reachable === true;

  const registeredModels = useMlflowRegisteredModels(reachable && tab === 'registered-models');
  const modelVersions = useMlflowModelVersions(reachable && tab === 'model-versions');
  const experiments = useMlflowExperiments(reachable && tab === 'experiments');
  const refresh = useRefreshMlflow();

  const models = registeredModels.data?.registered_models ?? [];
  const versions = modelVersions.data?.model_versions ?? [];
  const runs = experiments.data?.experiments ?? [];

  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      value={tab}
      onValueChange={(next) => void setTabParam(next === 'registered-models' ? null : next)}
    >
      <ScreenTemplate
        header={
          <PageHeader
            title="MLflow"
            meta={<span>Model registry of record — metadata and lineage; served weights live in the models bucket</span>}
            actions={
              <Button variant="outline" onClick={() => void refresh()} disabled={status.isFetching}>
                <IconRefresh aria-hidden />
                Refresh
              </Button>
            }
          />
        }
        stats={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Tracking server"
              value={status.isPending ? null : reachable ? 'Reachable' : 'Not reachable'}
              accent={status.isPending ? 'default' : reachable ? 'success' : 'destructive'}
              isLoading={status.isPending}
            />
            <StatCard label="Version" value={status.isPending ? null : (status.data?.version ?? '—')} isLoading={status.isPending} />
            <StatCard
              label="Probe latency"
              value={status.isPending ? null : typeof status.data?.latencyMs === 'number' ? `${status.data.latencyMs} ms` : '—'}
              isLoading={status.isPending}
            />
            <StatCard
              label="Embeddable"
              value={status.isPending ? null : status.data?.embeddable ? 'Yes' : 'No'}
              hint="Decided by the live probe"
              isLoading={status.isPending}
            />
          </div>
        }
        statusBanner={status.data ? <StatusBanner status={status.data} /> : undefined}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="registered-models">Registered models</TabsTrigger>
            <TabsTrigger value="model-versions">Model versions</TabsTrigger>
            <TabsTrigger value="experiments">Experiments</TabsTrigger>
            <TabsTrigger value="access">Access &amp; embedding</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={<span>{status.isFetching && !status.isPending ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/ai-services/mlflow/*
              </span>
            }
          />
        }
      >
        {status.isPending ? (
          <ListSkeleton />
        ) : status.error ? (
          <ErrorState title="Couldn’t read the MLflow status" error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <>
            <TabsContent value="registered-models">
              <ListingPanel
                reachable={reachable}
                isPending={registeredModels.isPending}
                error={registeredModels.error}
                onRetry={() => void registeredModels.refetch()}
                isEmpty={models.length === 0}
                emptyTitle="No registered models"
                emptyDescription="The registry answered, and it holds no registered models yet."
              >
                <ul className="flex flex-col">
                  {models.map((model, index) => (
                    <li key={model.name ?? index} className="flex flex-wrap items-start justify-between gap-3 border-b py-3 last:border-b-0">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-mono text-sm">{model.name ?? '—'}</span>
                        {model.description ? <span className="text-muted-foreground text-sm">{model.description}</span> : null}
                        {(model.aliases ?? []).length > 0 ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            {(model.aliases ?? []).map((alias) => (
                              <Badge key={`${alias.alias}-${alias.version}`} variant="secondary">
                                {alias.alias}
                                {alias.version ? ` → v${alias.version}` : ''}
                              </Badge>
                            ))}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">{formatEpochMillis(model.last_updated_timestamp) ?? ''}</span>
                    </li>
                  ))}
                </ul>
              </ListingPanel>
            </TabsContent>

            <TabsContent value="model-versions">
              <ListingPanel
                reachable={reachable}
                isPending={modelVersions.isPending}
                error={modelVersions.error}
                onRetry={() => void modelVersions.refetch()}
                isEmpty={versions.length === 0}
                emptyTitle="No model versions"
                emptyDescription="The registry answered, and no model version has been created yet."
              >
                <ul className="flex flex-col">
                  {versions.map((version, index) => (
                    <li
                      key={`${version.name}-${version.version}-${index}`}
                      className="flex flex-wrap items-start justify-between gap-3 border-b py-3 last:border-b-0"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-mono text-sm">
                          {version.name ?? '—'}
                          {version.version ? ` v${version.version}` : ''}
                        </span>
                        {/* The weights source, which is the whole reason this
                            registry is metadata-only: MLflow points at the
                            models bucket, it does not serve the bytes. */}
                        {version.source ? <span className="text-muted-foreground font-mono text-xs break-all">{version.source}</span> : null}
                        {version.status_message ? <span className="text-destructive text-xs">{version.status_message}</span> : null}
                        <span className="flex flex-wrap items-center gap-1.5">
                          {version.status ? <Badge variant={version.status === 'READY' ? 'default' : 'destructive'}>{version.status}</Badge> : null}
                          {(version.aliases ?? []).map((alias) => (
                            <Badge key={alias} variant="secondary">
                              {alias}
                            </Badge>
                          ))}
                        </span>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">{formatEpochMillis(version.last_updated_timestamp) ?? ''}</span>
                    </li>
                  ))}
                </ul>
              </ListingPanel>
            </TabsContent>

            <TabsContent value="experiments">
              <ListingPanel
                reachable={reachable}
                isPending={experiments.isPending}
                error={experiments.error}
                onRetry={() => void experiments.refetch()}
                isEmpty={runs.length === 0}
                emptyTitle="No experiments"
                emptyDescription="The tracking server answered, and it holds no experiments yet."
              >
                <ul className="flex flex-col">
                  {runs.map((experiment, index) => (
                    <li
                      key={experiment.experiment_id ?? index}
                      className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-mono text-sm">{experiment.name ?? '—'}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {experiment.experiment_id ? <Badge variant="outline">id {experiment.experiment_id}</Badge> : null}
                          {experiment.lifecycle_stage ? <Badge variant="outline">{experiment.lifecycle_stage}</Badge> : null}
                        </span>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">{formatEpochMillis(experiment.last_update_time) ?? ''}</span>
                    </li>
                  ))}
                </ul>
              </ListingPanel>
            </TabsContent>

            <TabsContent value="access">{status.data ? <AccessPanel status={status.data} /> : <ListSkeleton rows={3} />}</TabsContent>
          </>
        )}
      </ScreenTemplate>
    </Tabs>
  );
}
