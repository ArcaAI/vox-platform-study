'use client';

import { useState } from 'react';
import { IconClockExclamation, IconFilterOff, IconLicense } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import type { TenantPlan } from '@/features/tenants/api/types';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEnforcementEnabled, usePlanEntitlements, useRunTrialExpiry, useSetEnforcementEnabled } from '../api/hooks';
import type { PlanEntitlement } from '../api/types';
import { PlanEditDialog } from './plan-edit-dialog';
import { PLAN_LABELS, planSummary } from './plan-meta';
import { TenantOverridePanel } from './tenant-override-panel';

/** Platform-wide enforcement kill-switch — disabling requires a confirm. */
function EnforcementCard() {
  const { data, isLoading, error, refetch } = useEnforcementEnabled();
  const setEnforcement = useSetEnforcementEnabled();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function apply(enabled: boolean) {
    setEnforcement.mutate(enabled, {
      onSuccess: (result) => {
        toast.success(result.enabled ? 'Entitlement enforcement enabled' : 'Entitlement enforcement disabled');
        setConfirmOpen(false);
      },
      onError: (mutationError) => {
        toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not update enforcement.');
        setConfirmOpen(false);
      },
    });
  }

  return (
    <Card className="flex flex-row items-center justify-between gap-4 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="entitlements-enforcement">Entitlement enforcement</Label>
        <p className="text-muted-foreground text-sm">
          Platform-wide kill-switch. When off, plan limits and feature gates are evaluated but not enforced.
        </p>
      </div>
      {isLoading ? (
        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
      ) : error ? (
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      ) : (
        <Switch
          id="entitlements-enforcement"
          checked={data?.enabled ?? false}
          disabled={setEnforcement.isPending}
          onCheckedChange={(next) => (next ? apply(true) : setConfirmOpen(true))}
        />
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disable enforcement?"
        description="Every tenant immediately bypasses plan limits and feature gates until enforcement is re-enabled."
        confirmLabel="Disable enforcement"
        destructive
        onConfirm={() => apply(false)}
        isPending={setEnforcement.isPending}
      />
    </Card>
  );
}

/** Feature chips shown before the +N overflow badge (single-line cell). */

/** Frame 13 plans table: fill-height grid with in-toolbar search over the fixed plan set. */
function PlansTab() {
  const { data, isLoading, error, refetch } = usePlanEntitlements();
  const [editing, setEditing] = useState<TenantPlan | null>(null);

  const plans = data ?? [];

  const columns: ColumnDef<PlanEntitlement>[] = [
    {
      accessorKey: 'plan',
      header: 'Plan',
      enableSorting: false,
      meta: { label: 'Plan' },
      cell: ({ row }) => <span className="font-medium">{PLAN_LABELS[row.original.plan]}</span>,
      size: 140,
    },
    {
      id: 'entitlements',
      header: 'Key entitlements',
      enableSorting: false,
      meta: { label: 'Key entitlements' },
      cell: ({ row }) => <span className="text-muted-foreground">{planSummary(row.original)}</span>,
      size: 320,
      minSize: 220,
    },
    {
      accessorKey: 'modelTier',
      header: 'Model tier',
      enableSorting: false,
      meta: { label: 'Model tier' },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.modelTier}</span>,
      size: 140,
    },
    {
      accessorKey: 'rateLimitTier',
      header: 'Rate limit',
      enableSorting: false,
      meta: { label: 'Rate limit' },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.rateLimitTier}</span>,
      size: 140,
    },
    {
      id: 'version',
      header: 'Version',
      enableSorting: false,
      meta: { label: 'Version' },
      cell: ({ row }) => <span className="font-mono text-xs">v{row.original.version}</span>,
      size: 100,
    },
  ];

  // Grid-internal global search filters `plans` down; when it hides every row we
  // still hold plans, so branch the empty state on the unfiltered set.
  const empty =
    plans.length === 0 ? (
      <EmptyState
        icon={IconLicense}
        title="No plan entitlements yet"
        description="Tenants keep implicit defaults until the gateway seeds plan entitlements."
      />
    ) : (
      <EmptyState icon={IconFilterOff} title="No plans match your search" description="Try a different search or clear it." />
    );

  return (
    <>
      <VirtualizedDataGrid<PlanEntitlement>
        aria-label="Plan entitlements"
        columns={columns}
        data={plans}
        getRowId={(row) => row.id}
        features={{
          globalSearch: true,
          facetedFilters: false,
          sorting: false,
          rowSelection: false,
          columnReorder: true,
          columnResize: true,
          columnPinning: true,
          columnVisibility: true,
        }}
        persistence={gridPersistence('entitlement-plans')}
        isLoading={isLoading}
        error={error ?? undefined}
        errorState={(err) => <ErrorState error={err} onRetry={() => refetch()} />}
        emptyState={empty}
        onRowClick={(row) => setEditing(row.plan)}
      />
      <PlanEditDialog plan={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </>
  );
}

/** Frame 13 — Entitlements & plans: enforcement switch, plan matrix, overrides. */
export function EntitlementsScreen() {
  const plansQuery = usePlanEntitlements();
  const runTrialExpiry = useRunTrialExpiry();
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('plans'));
  const [trialExpiryOpen, setTrialExpiryOpen] = useState(false);
  const tab = tabParam === 'overrides' ? 'overrides' : 'plans';

  function handleTrialExpiryConfirmed() {
    runTrialExpiry.mutate(undefined, {
      onSuccess: (report) => {
        toast.success(`Trial expiry sweep done \u2014 examined ${formatNumber(report.examined)}, downgraded ${formatNumber(report.downgraded)}`);
        setTrialExpiryOpen(false);
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not run the trial-expiry sweep.');
        setTrialExpiryOpen(false);
      },
    });
  }

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => setTabParam(next === 'plans' ? null : next)}>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Entitlements & Plans"
            meta={plansQuery.data ? <span>{formatNumber(plansQuery.data.length)} plans</span> : <Skeleton className="h-4 w-16" />}
            actions={
              <Button variant="outline" onClick={() => setTrialExpiryOpen(true)}>
                <IconClockExclamation aria-hidden />
                Run trial expiry
              </Button>
            }
          />
        }
        statusBanner={<EnforcementCard />}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="plans">Plans</TabsTrigger>
            <TabsTrigger value="overrides">Tenant overrides</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/entitlements/plans
              </span>
            }
          />
        }
      >
        <TabsContent value="plans" className="flex min-h-0 flex-col">
          <PlansTab />
        </TabsContent>
        <TabsContent value="overrides" className="overflow-y-auto">
          <TenantOverridePanel />
        </TabsContent>
      </ScreenTemplate>
      <ConfirmDialog
        open={trialExpiryOpen}
        onOpenChange={setTrialExpiryOpen}
        title="Run trial expiry?"
        description="Examines every trial tenant and downgrades the expired ones to their fallback plan."
        confirmLabel="Run trial expiry"
        onConfirm={handleTrialExpiryConfirmed}
        isPending={runTrialExpiry.isPending}
      />
    </Tabs>
  );
}
