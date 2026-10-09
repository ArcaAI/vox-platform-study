'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { IconAlertTriangle, IconClock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import {
  isTerminalResidencyOperation,
  RESIDENCY_OPERATION_TIMEOUT_MS,
  residencyErrorMessage,
  useModelResidencyOperation,
  type LmStudioResidencyLoadOptions,
  type LoadModelResidencyResponse,
  type ModelResidencyOperation,
} from '@/shared/residency';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { modelResidencyKeys, useLoadResidencyModel, useModelResidencyCatalogue, useModelResidencyReadiness } from '../api';
import type { ModelResidencyCatalogueResponse, ResidencyCatalogueModel, ResidencyServiceGroup } from '../api/types';
import { AttentionStrip } from './attention-strip';
import { GpuSummaryPanel } from './gpu-summary-panel';
import { LinkInstanceDialog } from './link-instance-dialog';
import { LoadPreviewDialog } from './load-preview-dialog';
import { ModelDetailDrawer } from './model-detail-drawer';
import { ModelsTable, pendingKey } from './models-table';
import { deriveAttentionItems, formatDataAge, formatReportingServices } from './residency-display';
import { ReloadConfirmDialog } from './reload-confirm-dialog';
import { SuggestionsPanel } from './suggestions-panel';
import { UnloadDialog } from './unload-dialog';

/** A row addressed by its stable keys — resolved against the LATEST catalogue on every render. */
type RowKey = { service: string; modelRef: string };
type Resolved = { service: ResidencyServiceGroup; model: ResidencyCatalogueModel };
type PendingOperation = { operationId: string; name: string };

const READINESS_HREF = '/model-residency/readiness';
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function resolve(data: ModelResidencyCatalogueResponse, key: RowKey | null): Resolved | null {
  if (!key) return null;
  const service = data.services.find((candidate) => candidate.service === key.service);
  const model = service?.models.find((candidate) => candidate.modelRef === key.modelRef);
  return service && model ? { service, model } : null;
}

function toKey(service: ResidencyServiceGroup, model: ResidencyCatalogueModel): RowKey {
  return { service: service.service, modelRef: model.modelRef };
}

/**
 * Polls ONE admitted load to a terminal state. One watcher per pending model
 * (C-a): a second load no longer overwrites the first one's operation id.
 */
function OperationWatcher({
  operationId,
  onTerminal,
  onLost,
}: {
  operationId: string;
  onTerminal: (operation: ModelResidencyOperation) => void;
  /** The poll errored (e.g. 404 after a gateway restart) or never finished within the timeout. */
  onLost: () => void;
}) {
  const query = useModelResidencyOperation(operationId);
  const operation = query.data;
  const terminal = operation ? isTerminalResidencyOperation(operation.status) : false;
  useEffect(() => {
    if (operation && isTerminalResidencyOperation(operation.status)) onTerminal(operation);
  }, [operation, onTerminal]);
  // Held in a ref so a parent re-render (the catalogue polls) never restarts the timeout.
  const lostRef = useRef(onLost);
  useEffect(() => {
    lostRef.current = onLost;
  }, [onLost]);
  useEffect(() => {
    if (query.isError && !terminal) lostRef.current();
  }, [query.isError, terminal]);
  useEffect(() => {
    if (terminal) return;
    const timer = setTimeout(() => lostRef.current(), RESIDENCY_OPERATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [terminal]);
  return null;
}

/** Body skeleton shared with the route's `loading.tsx` (rule 10: mirrors the loaded layout). */
export function ModelResidencySkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-2 rounded-xl border p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-5 w-32" />
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="flex flex-col gap-3 rounded-xl border p-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-full" />
                {Array.from({ length: 3 }, (__, line) => (
                  <Skeleton key={line} className="h-3 w-3/4" />
                ))}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3 rounded-xl border p-4">
            <Skeleton className="h-5 w-28" />
            <div className="flex gap-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-6 w-28" />
              ))}
            </div>
            <div className="flex gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-8 w-24 rounded-full" />
              ))}
            </div>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-8 w-40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReadinessLink({ label }: { label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={READINESS_HREF}>{label}</Link>
    </Button>
  );
}

/**
 * Model residency overview (TASK-1051 artboard 01). Every model each service
 * can run — loaded or not — in ONE table grouped by service, with what needs
 * attention first, the GPU memory picture, and the shadow-mode
 * recommendations beside the content. Platform-admin only (D-11), no tenant
 * scope. One `GET admin/model-residency/catalogue` read, polled every 10 s.
 *
 * Load / unload / link go through lane C2's dialogs (each toasts its own
 * outcome); the screen tracks the async load OPERATIONS they admit, one per
 * model, and toasts each terminal state exactly once.
 */
export function ModelResidencyScreen() {
  const catalogue = useModelResidencyCatalogue();
  const queryClient = useQueryClient();
  const reload = useLoadResidencyModel();
  const readiness = useModelResidencyReadiness();
  const [reloadTarget, setReloadTarget] = useState<{ key: RowKey; options: LmStudioResidencyLoadOptions } | null>(null);

  const [drawerKey, setDrawerKey] = useState<RowKey | null>(null);
  const [loadKey, setLoadKey] = useState<RowKey | null>(null);
  const [unloadKey, setUnloadKey] = useState<RowKey | null>(null);
  const [linkKey, setLinkKey] = useState<RowKey | null>(null);

  // C-a: pending operations keyed per model; C-b: ids already toasted.
  const [pending, setPending] = useState<Record<string, PendingOperation>>({});
  const toasted = useRef(new Set<string>());

  const track = useCallback((service: string, modelRef: string, operationId: string, name: string) => {
    setPending((current) => ({ ...current, [pendingKey(service, modelRef)]: { operationId, name } }));
  }, []);

  const handleTerminal = useCallback(
    (key: string, name: string, operation: ModelResidencyOperation) => {
      if (toasted.current.has(operation.id)) return;
      toasted.current.add(operation.id);
      if (operation.status === 'succeeded') toast.success(`${name} loaded.`);
      else if (operation.error?.message)
        toast.error(`Loading ${name} failed: ${operation.error.message}${operation.error.code ? ` (${operation.error.code})` : ''}`);
      else toast.error(operation.error?.code ? `Loading ${name} failed (${operation.error.code}).` : `Loading ${name} failed.`);
      setPending((current) => {
        if (current[key]?.operationId !== operation.id) return current;
        return Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key));
      });
      void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
    },
    [queryClient],
  );

  const handleLost = useCallback(
    (key: string, name: string, operationId: string) => {
      if (toasted.current.has(operationId)) return;
      toasted.current.add(operationId);
      toast.error(`Lost track of the load of ${name} — refreshing.`);
      setPending((current) => {
        if (current[key]?.operationId !== operationId) return current;
        return Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key));
      });
      void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
    },
    [queryClient],
  );

  const pendingKeys = useMemo(() => new Set(Object.keys(pending)), [pending]);

  const openLoad = useCallback((service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => setLoadKey(toKey(service, model)), []);
  const openUnload = useCallback((service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => setUnloadKey(toKey(service, model)), []);
  const openLink = useCallback((service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => setLinkKey(toKey(service, model)), []);
  const openDrawer = useCallback((service: ResidencyServiceGroup, model: ResidencyCatalogueModel) => setDrawerKey(toKey(service, model)), []);

  function handleAdmitted(target: Resolved, response: LoadModelResidencyResponse) {
    setLoadKey(null);
    // The dialog toasts only its failures; an accepted load is followed to its terminal state, an already-resident one is said here.
    if (response.outcome === 'accepted' && response.operationId) {
      track(target.service.service, target.model.modelRef, response.operationId, target.model.name);
    } else if (response.outcome === 'already_loaded') {
      toast.success(`${target.model.name} is already loaded.`);
    }
  }

  function handleReload(service: ResidencyServiceGroup, model: ResidencyCatalogueModel, options: LmStudioResidencyLoadOptions) {
    setReloadTarget({ key: toKey(service, model), options });
  }

  function confirmReload(
    service: ResidencyServiceGroup,
    model: ResidencyCatalogueModel,
    options: LmStudioResidencyLoadOptions,
    reason: string | null,
  ) {
    reload.mutate(
      { service: service.service, modelRef: model.modelRef, replace: true, options, ...(reason ? { force: true, reason } : {}) },
      {
        onSuccess: (response) => {
          setReloadTarget(null);
          if (response.outcome === 'already_loaded') {
            toast.success(`${model.name} is already resident on that profile.`);
            return;
          }
          if (response.operationId) track(service.service, model.modelRef, response.operationId, model.name);
        },
        onError: (error) => toast.error(residencyErrorMessage(error, `Couldn't reload ${model.name}.`)),
      },
    );
  }

  const readinessData = readiness.isError ? undefined : readiness.data;
  const readinessLabel = readinessData ? `Enforce readiness · ${readinessData.passed} of ${readinessData.total}` : 'Enforce readiness';
  const shadowReviewMissing = readinessData?.checks.some((check) => check.id === 'shadow_review_recorded' && !check.passed) ?? false;
  const header = (meta?: ReactNode) => <PageHeader title="Model residency" meta={meta} actions={<ReadinessLink label={readinessLabel} />} />;

  if (catalogue.isLoading) {
    return (
      <ScreenTemplate header={header()}>
        <ModelResidencySkeleton />
      </ScreenTemplate>
    );
  }

  if (catalogue.error && !catalogue.data) {
    return (
      <ScreenTemplate header={header()}>
        <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      </ScreenTemplate>
    );
  }

  const data = catalogue.data;
  if (!data) return null;

  const now = new Date();
  const stale = data.freshness.staleServices;
  const staleLabels = stale.map((id) => data.services.find((service) => service.service === id)?.label ?? id);
  const freshness = [
    formatReportingServices(data.services, stale),
    formatDataAge(data.freshness.oldestReportAt, now),
    ...(stale.length > 0 ? [`stale: ${staleLabels.join(', ')}`] : []),
  ].join(' · ');

  const drawer = resolve(data, drawerKey);
  const loadTarget = resolve(data, loadKey);
  const unloadTarget = resolve(data, unloadKey);
  const linkTarget = resolve(data, linkKey);
  const reloadResolved = resolve(data, reloadTarget?.key ?? null);

  return (
    <>
      <ScreenTemplate
        header={header(
          <>
            <Badge variant="secondary">
              <IconClock aria-hidden />
              {data.mode === 'shadow' ? 'Shadow mode — recommends, never acts' : 'Automatic'}
            </Badge>
            <Badge
              variant="outline"
              data-testid="residency-freshness"
              data-stale={stale.length > 0 ? 'true' : 'false'}
              className={cn('whitespace-normal', stale.length > 0 && 'border-warning-strong/50 text-warning-strong')}
            >
              {stale.length > 0 ? <IconAlertTriangle aria-hidden /> : null}
              {freshness}
            </Badge>
            {shadowReviewMissing ? (
              <Badge variant="outline" className="border-warning-strong/50 text-warning-strong">
                <IconAlertTriangle aria-hidden />
                Shadow review not recorded
              </Badge>
            ) : null}
          </>,
        )}
        statusBanner={catalogue.error ? <ErrorBanner error={catalogue.error} onRetry={() => void catalogue.refetch()} /> : undefined}
        footer={
          <StatusFooter
            start={<span>auto-refresh 10 s &middot; catalogue observed {timeFormat.format(new Date(data.reportedAt))}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/model-residency/catalogue
              </span>
            }
          />
        }
      >
        <div className="flex flex-col gap-4">
          <AttentionStrip items={deriveAttentionItems(data)} onLink={openLink} onLoad={openLoad} />
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-4">
              <GpuSummaryPanel devices={data.devices} services={data.services} />
              <ModelsTable
                services={data.services}
                devices={data.devices}
                pendingKeys={pendingKeys}
                onLoad={openLoad}
                onUnload={openUnload}
                onLink={openLink}
                onOpenDrawer={openDrawer}
              />
            </div>
            <SuggestionsPanel suggestions={data.suggestions} services={data.services} onApplyLoad={openLoad} onApplyUnload={openUnload} now={now} />
          </div>
        </div>
      </ScreenTemplate>

      {Object.entries(pending).map(([key, operation]) => (
        <OperationWatcher
          key={operation.operationId}
          operationId={operation.operationId}
          onTerminal={(result) => handleTerminal(key, operation.name, result)}
          onLost={() => handleLost(key, operation.name, operation.operationId)}
        />
      ))}

      {drawer ? (
        <ModelDetailDrawer
          open
          onOpenChange={(next) => {
            if (!next) setDrawerKey(null);
          }}
          service={drawer.service}
          model={drawer.model}
          devices={data.devices}
          actionPending={reload.isPending}
          onLoad={openLoad}
          onUnload={openUnload}
          onReload={handleReload}
          onLink={openLink}
        />
      ) : null}

      {reloadTarget && reloadResolved ? (
        <ReloadConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setReloadTarget(null);
          }}
          service={reloadResolved.service}
          model={reloadResolved.model}
          options={reloadTarget.options}
          isPending={reload.isPending}
          onConfirm={(reason) => confirmReload(reloadResolved.service, reloadResolved.model, reloadTarget.options, reason)}
        />
      ) : null}

      {loadTarget ? (
        <LoadPreviewDialog
          open
          onOpenChange={(next) => {
            if (!next) setLoadKey(null);
          }}
          service={loadTarget.service}
          model={loadTarget.model}
          onAdmitted={(response) => handleAdmitted(loadTarget, response)}
        />
      ) : null}

      {unloadTarget ? (
        <UnloadDialog
          open
          onOpenChange={(next) => {
            if (!next) setUnloadKey(null);
          }}
          service={unloadTarget.service}
          model={unloadTarget.model}
          onUnloaded={() => setUnloadKey(null)}
        />
      ) : null}

      {linkTarget ? (
        <LinkInstanceDialog
          open
          onOpenChange={(next) => {
            if (!next) setLinkKey(null);
          }}
          service={linkTarget.service}
          model={linkTarget.model}
          onLinked={() => {
            setLinkKey(null);
            setDrawerKey(null);
          }}
        />
      ) : null}
    </>
  );
}
