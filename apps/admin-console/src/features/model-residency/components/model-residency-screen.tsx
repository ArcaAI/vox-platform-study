'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import {
  asModelResidencyConflict,
  isTerminalResidencyOperation,
  useModelResidencyOperation,
  type LmStudioResidencyLoadOptions,
} from '@/shared/residency';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { formatRelativeTime } from '@/shared/format';
import { modelResidencyKeys, useLoadResidencyModel, useModelResidencyCatalogue, useUnloadResidencyModel } from '../api';
import type { ResidencyCatalogueModel, ResidencyServiceGroup } from '../api/types';
import { ForceActionDialog } from './force-action-dialog';
import { GpuSummaryPanel } from './gpu-summary-panel';
import { ModelDetailDrawer } from './model-detail-drawer';
import { ServiceSection } from './service-section';
import { SuggestionsPanel } from './suggestions-panel';

type DrawerTarget = { service: ResidencyServiceGroup; model: ResidencyCatalogueModel };
type ForceTarget = { kind: 'load' | 'unload'; service: ResidencyServiceGroup; model: ResidencyCatalogueModel };

function CatalogueSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-md border p-4">
          <Skeleton className="h-4 w-56" />
          {Array.from({ length: 2 }, (__, row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Model residency (ticket §13 — the catalogue-first redesign). Every
 * self-hosted `AiModel`, grouped by the service that can run it, loaded or
 * not — so "which model will be loaded and handled by what service" (the
 * owner's complaint about the shipped screen) is answered by the page
 * itself. Platform-admin only (D-11, reconfirmed 2026-09-25), no tenant
 * scope. One `GET admin/model-residency/catalogue` read, polled every 10s.
 */
export function ModelResidencyScreen() {
  const catalogue = useModelResidencyCatalogue();
  const queryClient = useQueryClient();
  const loadMutation = useLoadResidencyModel();
  const unloadMutation = useUnloadResidencyModel();

  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  const [forceTarget, setForceTarget] = useState<ForceTarget | null>(null);
  const [confirmUnloadTarget, setConfirmUnloadTarget] = useState<DrawerTarget | null>(null);
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);
  const operationQuery = useModelResidencyOperation(pendingOperationId);

  // The load/reload route is asynchronous (~100s for a real LLM, past
  // Cloudflare's 100s edge timeout), so it only ADMITS the load. Poll the
  // operation to a terminal state, then refresh the catalogue so the
  // optimistic "loading" row is replaced by the real one (or removed, on
  // failure). No `setPendingOperationId` here: `refetchInterval` already
  // stops once terminal, and the id is overwritten by the next load anyway.
  useEffect(() => {
    const operation = operationQuery.data;
    if (!operation || !isTerminalResidencyOperation(operation.status)) return;
    void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.catalogue() });
    if (operation.status === 'succeeded') {
      toast.success(`${operation.modelRef} loaded.`);
    } else {
      toast.error(operation.error?.message || `Loading ${operation.modelRef} failed.`);
    }
  }, [operationQuery.data, queryClient]);

  function requestLoad(service: ResidencyServiceGroup, model: ResidencyCatalogueModel, force = false, reason?: string) {
    loadMutation.mutate(
      { service: service.service, modelRef: model.modelRef, force, reason: force ? reason : undefined },
      {
        onSuccess: (response) => {
          setForceTarget(null);
          if (response.outcome === 'already_loaded') {
            toast.success(`${model.name} is already resident.`);
            return;
          }
          setPendingOperationId(response.operationId ?? null);
          toast.success(`Loading ${model.name}…`);
        },
        onError: (error) => {
          const conflict = asModelResidencyConflict(error);
          if (conflict?.code === 'OVER_BUDGET' && !force) {
            setForceTarget({ kind: 'load', service, model });
            return;
          }
          toast.error(conflict?.message || `Couldn't load ${model.name}.`);
        },
      },
    );
  }

  function requestUnload(service: ResidencyServiceGroup, model: ResidencyCatalogueModel, force = false, reason?: string) {
    unloadMutation.mutate(
      { service: service.service, modelRef: model.modelRef, force, reason: force ? reason : undefined },
      {
        onSuccess: () => {
          toast.success(`${model.name} unloaded.`);
          setForceTarget(null);
          setConfirmUnloadTarget(null);
        },
        onError: (error) => {
          const conflict = asModelResidencyConflict(error);
          if (conflict?.code === 'IN_FLIGHT') {
            setConfirmUnloadTarget(null);
            setForceTarget({ kind: 'unload', service, model });
            return;
          }
          toast.error(conflict?.message || `Couldn't unload ${model.name}.`);
        },
      },
    );
  }

  function handleUnloadClick(service: ResidencyServiceGroup, model: ResidencyCatalogueModel) {
    if (model.residency && model.residency.inFlight > 0) {
      setForceTarget({ kind: 'unload', service, model });
    } else {
      setConfirmUnloadTarget({ service, model });
    }
  }

  function handleReload(service: ResidencyServiceGroup, model: ResidencyCatalogueModel, options: LmStudioResidencyLoadOptions) {
    loadMutation.mutate(
      { service: service.service, modelRef: model.modelRef, replace: true, options },
      {
        onSuccess: (response) => {
          if (response.outcome === 'already_loaded') {
            toast.success(`${model.name} is already resident on that profile.`);
            return;
          }
          setPendingOperationId(response.operationId ?? null);
          toast.success(`Reloading ${model.name}…`);
        },
        onError: (error) => {
          const conflict = asModelResidencyConflict(error);
          toast.error(conflict?.message || `Couldn't reload ${model.name}.`);
        },
      },
    );
  }

  if (catalogue.isLoading) {
    return (
      <ScreenTemplate header={<PageHeader title="Model residency" />}>
        <CatalogueSkeleton />
      </ScreenTemplate>
    );
  }

  if (catalogue.error && !catalogue.data) {
    return (
      <ScreenTemplate header={<PageHeader title="Model residency" />}>
        <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      </ScreenTemplate>
    );
  }

  const data = catalogue.data;
  if (!data) return null;

  const actionPending = loadMutation.isPending || unloadMutation.isPending;

  return (
    <>
      <ScreenTemplate
        header={
          <PageHeader
            title="Model residency"
            meta={
              <>
                <Badge variant="secondary">{data.mode === 'shadow' ? 'Suggestions only — nothing is loaded automatically' : 'Automatic'}</Badge>
                <span>
                  {data.freshness.staleServices.length > 0
                    ? `Stale reports from: ${data.freshness.staleServices.join(', ')}`
                    : `Every service reported within ${data.freshness.maxAgeSeconds}s`}
                </span>
              </>
            }
          />
        }
        stats={
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <GpuSummaryPanel devices={data.devices} />
            <SuggestionsPanel suggestions={data.suggestions} />
          </div>
        }
        footer={
          <StatusFooter
            start={<span>auto-refresh 10s &middot; reported {formatRelativeTime(data.reportedAt)}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/model-residency/catalogue
              </span>
            }
          />
        }
      >
        <div className="flex flex-col gap-4">
          {data.services.map((service) => (
            <ServiceSection
              key={service.service}
              service={service}
              devices={data.devices}
              onLoad={requestLoad}
              onUnload={handleUnloadClick}
              onOpenDrawer={(service, model) => setDrawerTarget({ service, model })}
            />
          ))}
          <Card className="gap-1 p-4">
            <p className="text-muted-foreground text-xs">
              &ldquo;Always loaded&rdquo; means a live-consultation agent uses the model, or a platform admin pinned it &mdash; the controller never
              unloads it. Sizes shown with a leading ~ are catalogue estimates; sizes without one are measured on the running instance.
            </p>
          </Card>
        </div>
      </ScreenTemplate>

      {drawerTarget ? (
        <ModelDetailDrawer
          open
          onOpenChange={(next) => {
            if (!next) setDrawerTarget(null);
          }}
          service={drawerTarget.service}
          model={drawerTarget.model}
          devices={data.devices}
          actionPending={actionPending}
          onLoad={requestLoad}
          onUnload={handleUnloadClick}
          onReload={handleReload}
        />
      ) : null}

      <ConfirmDialog
        open={confirmUnloadTarget !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmUnloadTarget(null);
        }}
        title={confirmUnloadTarget ? `Unload ${confirmUnloadTarget.model.name}?` : ''}
        description="Frees this model's device memory. A future request loads it again on the usual keep policy."
        confirmLabel="Unload"
        isPending={unloadMutation.isPending}
        onConfirm={() => {
          if (confirmUnloadTarget) requestUnload(confirmUnloadTarget.service, confirmUnloadTarget.model);
        }}
      />

      <ForceActionDialog
        open={forceTarget !== null}
        onOpenChange={(next) => {
          if (!next) setForceTarget(null);
        }}
        title={forceTarget ? `Force ${forceTarget.kind === 'load' ? 'load' : 'unload'} ${forceTarget.model.name}?` : ''}
        description={
          forceTarget?.kind === 'load'
            ? 'The controller refused this load against the measured free memory on the target device.'
            : `This model is serving ${forceTarget?.model.residency?.inFlight ?? 'some'} request(s) right now. Forcing the unload drops them in flight.`
        }
        confirmLabel={forceTarget?.kind === 'load' ? 'Force load' : 'Force unload'}
        isPending={actionPending}
        onConfirm={(reason) => {
          if (!forceTarget) return;
          if (forceTarget.kind === 'load') requestLoad(forceTarget.service, forceTarget.model, true, reason);
          else requestUnload(forceTarget.service, forceTarget.model, true, reason);
        }}
      />
    </>
  );
}
