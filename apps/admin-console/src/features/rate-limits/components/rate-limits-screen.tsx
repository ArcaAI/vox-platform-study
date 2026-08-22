'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconPencil, IconPlayerPause, IconPlayerPlay, IconRoute } from '@tabler/icons-react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { useRateLimitPolicy, useSetRateLimitEnabled, useSetRouteOverride, useSetTierOverride } from '../api/hooks';
import type { RateLimitRoutePolicy, RateLimitTierPolicy } from '../api/types';
import { RateLimitExplainPanel } from './rate-limit-explain-panel';
import { RateLimitPlansPanel } from './rate-limit-plans-panel';
import { RateLimitRulesPanel } from './rate-limit-rules-panel';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
];

function SourceBadges({ limitSource, ttlSource }: { limitSource: string; ttlSource: string }) {
  return (
    <span className="flex items-center gap-1">
      <Badge variant="outline" className="text-muted-foreground font-mono text-2xs">
        limit: {limitSource}
      </Badge>
      <Badge variant="outline" className="text-muted-foreground font-mono text-2xs">
        ttl: {ttlSource}
      </Badge>
    </span>
  );
}

/**
 * Shared limit/ttl override editor for tiers and routes. Mounted per target
 * (parent keys it) so the inputs initialize from the current effective values.
 */
function OverrideDialog({
  title,
  description,
  initialLimit,
  initialTtl,
  isPending,
  onOpenChange,
  onSave,
}: {
  title: string;
  description: string;
  initialLimit: number;
  initialTtl: number;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (limit: number, ttl: number) => void;
}) {
  const uid = useId();
  const [limit, setLimit] = useState(String(initialLimit));
  const [ttl, setTtl] = useState(String(initialTtl));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(Number(limit), Number(ttl));
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-limit`}>Limit (requests)</Label>
              <Input id={`${uid}-limit`} type="number" min={1} required value={limit} onChange={(event) => setLimit(event.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-ttl`}>TTL (seconds)</Label>
              <Input id={`${uid}-ttl`} type="number" min={1} required value={ttl} onChange={(event) => setTtl(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Spinner /> : null}
              Save override
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Skeletons mirroring the three loaded regions (rule 10). */
function RateLimitsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="bg-card flex items-center justify-between gap-4 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
      {[4, 6].map((rowCount, region) => (
        <div key={region} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-36" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: rowCount }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Frame 16 — Rate Limits (/rate-limits, tier 10-19). Single-policy screen:
 * global kill-switch (confirm on disable), per-tier defaults with override
 * editing, and the gateway route registry with limit/ttl overrides and
 * pause/resume — every write returns the fresh policy.
 */
export function RateLimitsScreen() {
  const headingId = useId();
  const query = useRateLimitPolicy();
  const policy = query.data;

  const [search, setSearch] = useQueryState('q', { defaultValue: '' });
  const [tierFilter, setTierFilter] = useQueryState('tier', { defaultValue: '' });
  const [statusFilter, setStatusFilter] = useQueryState('status', { defaultValue: '' });

  const enabledMutation = useSetRateLimitEnabled();
  const tierMutation = useSetTierOverride();
  const routeMutation = useSetRouteOverride();

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [tierEdit, setTierEdit] = useState<RateLimitTierPolicy | null>(null);
  const [routeEdit, setRouteEdit] = useState<RateLimitRoutePolicy | null>(null);
  const [pauseTarget, setPauseTarget] = useState<RateLimitRoutePolicy | null>(null);

  function mutateEnabled(enabled: boolean) {
    enabledMutation.mutate(enabled, {
      onSuccess: () => {
        toast.success(enabled ? 'Rate limiting enabled' : 'Rate limiting disabled');
        setConfirmDisable(false);
      },
      onError: (error) => toast.error(error.message),
    });
  }

  function handleEnabledChange(next: boolean) {
    if (next) {
      mutateEnabled(true);
    } else {
      // Turning protection OFF is the destructive direction — confirm first.
      setConfirmDisable(true);
    }
  }

  function setRouteEnabled(route: RateLimitRoutePolicy, enabled: boolean) {
    routeMutation.mutate(
      { routeId: route.routeId, body: { enabled } },
      {
        onSuccess: () => {
          toast.success(enabled ? 'Route resumed' : 'Route paused');
          setPauseTarget(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  const routes = policy?.routes ?? [];
  const filteredRoutes = routes.filter((route) => {
    if (tierFilter && route.tier !== tierFilter) return false;
    if (statusFilter === 'active' && !route.enabled) return false;
    if (statusFilter === 'paused' && route.enabled) return false;
    if (search) {
      const haystack = `${route.routeId} ${route.description} ${route.controller} ${route.handler ?? ''}`.toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const tierColumns: ColumnDef<RateLimitTierPolicy>[] = [
    {
      accessorKey: 'tier',
      header: 'Tier',
      enableSorting: false,
      meta: { label: 'Tier' },
      cell: ({ row }) => <span className="font-medium">{row.original.tier}</span>,
      size: 160,
    },
    {
      accessorKey: 'limit',
      header: 'Limit',
      enableSorting: false,
      meta: { label: 'Limit' },
      cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.limit)}</span>,
      size: 120,
    },
    {
      accessorKey: 'ttl',
      header: 'Window',
      enableSorting: false,
      meta: { label: 'Window' },
      cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{formatNumber(row.original.ttl)} s</span>,
      size: 120,
    },
    {
      id: 'sources',
      header: 'Sources',
      enableSorting: false,
      meta: { label: 'Sources' },
      cell: ({ row }) => <SourceBadges limitSource={row.original.limitSource} ttlSource={row.original.ttlSource} />,
      size: 220,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { label: 'Actions' },
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      size: 56,
      minSize: 56,
      cell: ({ row }) => (
        <span className="flex w-full justify-end">
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.original.tier} tier`} onClick={() => setTierEdit(row.original)}>
            <IconPencil aria-hidden />
          </Button>
        </span>
      ),
    },
  ];

  const routeColumns: ColumnDef<RateLimitRoutePolicy>[] = [
    {
      accessorKey: 'routeId',
      header: 'Route',
      enableSorting: false,
      meta: { label: 'Route' },
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.routeId}</span>,
      size: 240,
      minSize: 160,
    },
    {
      accessorKey: 'description',
      header: 'Description',
      enableSorting: false,
      meta: { label: 'Description' },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.description}</span>,
      size: 200,
    },
    {
      accessorKey: 'tier',
      header: 'Tier',
      enableSorting: false,
      meta: { label: 'Tier' },
      cell: ({ row }) => <Badge variant="secondary">{row.original.tier}</Badge>,
      size: 120,
    },
    {
      id: 'limit',
      header: 'Limit',
      enableSorting: false,
      meta: { label: 'Limit' },
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatNumber(row.original.limit)} <span className="text-muted-foreground">/ {formatNumber(row.original.ttl)} s</span>
        </span>
      ),
      size: 140,
    },
    {
      id: 'sources',
      header: 'Sources',
      enableSorting: false,
      meta: { label: 'Sources' },
      cell: ({ row }) => <SourceBadges limitSource={row.original.limitSource} ttlSource={row.original.ttlSource} />,
      size: 220,
    },
    {
      accessorKey: 'enabled',
      header: 'Status',
      enableSorting: false,
      meta: { label: 'Status' },
      cell: ({ row }) =>
        row.original.enabled ? (
          <StatusBadge label="Active" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
        ) : (
          <StatusBadge label="Paused" colorRole="neutral" icon={<StatusDot colorRole="neutral" size="sm" />} />
        ),
      size: 120,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { label: 'Actions' },
      enableSorting: false,
      enableHiding: false,
      enableResizing: false,
      size: 88,
      minSize: 88,
      cell: ({ row }) => (
        <span className="flex w-full items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${row.original.routeId}`}
            disabled={routeMutation.isPending}
            onClick={() => setRouteEdit(row.original)}
          >
            <IconPencil aria-hidden />
          </Button>
          {row.original.enabled ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Pause ${row.original.routeId}`}
              disabled={routeMutation.isPending}
              onClick={() => setPauseTarget(row.original)}
            >
              <IconPlayerPause aria-hidden />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Resume ${row.original.routeId}`}
              disabled={routeMutation.isPending}
              onClick={() => setRouteEnabled(row.original, true)}
            >
              <IconPlayerPlay aria-hidden />
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      {/*
        Tabs wrap the template so the list can live in the pinned `tabs` region
        while the panels are `children` — the shared-context shape
        `11-ux-ui-principles.md` §Screen Template requires. `variant="line"` is
        the console standard; the bare default renders a segmented pill.
      */}
      <Tabs defaultValue="policy">
        <ScreenTemplate
          header={
            <PageHeader
              title="Rate Limits"
              meta={
                policy ? (
                  <>
                    <span>{formatNumber(policy.tiers.length)} tiers</span>
                    <span aria-hidden>&middot;</span>
                    <span>{formatNumber(policy.routes.length)} routes</span>
                  </>
                ) : null
              }
            />
          }
          statusBanner={policy && query.error ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="policy">Policy</TabsTrigger>
              <TabsTrigger value="rules">Rules</TabsTrigger>
              <TabsTrigger value="plans">Plans</TabsTrigger>
              <TabsTrigger value="explain">Explain</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/rate-limit
                </span>
              }
            />
          }
        >
          <TabsContent value="policy" className="flex flex-col gap-6">
            {query.isPending ? (
              <RateLimitsSkeleton />
            ) : query.error && !policy ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : policy ? (
              <>
                <section
                  aria-labelledby={`${headingId}-kill-switch`}
                  className="bg-card flex flex-wrap items-center justify-between gap-4 rounded-md border p-4"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 id={`${headingId}-kill-switch`} className="text-base font-semibold">
                      Rate limiting
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Global kill-switch for the Redis sliding-window limiter. Disabling leaves every route unprotected.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge variant="outline" className="text-muted-foreground font-mono text-2xs">
                      source: {policy.enabledSource}
                    </Badge>
                    <span className="text-sm font-medium">{policy.enabled ? 'Enabled' : 'Disabled'}</span>
                    <Switch
                      checked={policy.enabled}
                      onCheckedChange={handleEnabledChange}
                      disabled={enabledMutation.isPending}
                      aria-label="Rate limiting enabled"
                    />
                  </div>
                </section>
                <section aria-labelledby={`${headingId}-tiers`} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 id={`${headingId}-tiers`} className="text-base font-semibold">
                      Tier defaults
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Requests allowed per window for each guard tier. Saved overrides persist to the DB (source: db).
                    </p>
                  </div>
                  <VirtualizedDataGrid<RateLimitTierPolicy>
                    aria-label="Tier defaults"
                    columns={tierColumns}
                    data={policy.tiers}
                    getRowId={(tier) => tier.tier}
                    height={240}
                    toolbar={false}
                    features={{
                      globalSearch: false,
                      facetedFilters: false,
                      sorting: false,
                      rowSelection: false,
                      columnReorder: false,
                      columnResize: false,
                      columnPinning: false,
                      columnVisibility: false,
                    }}
                    emptyState={<EmptyState icon={IconRoute} title="No tiers reported" description="The gateway did not report any guard tiers." />}
                  />
                </section>
                <section aria-labelledby={`${headingId}-routes`} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 id={`${headingId}-routes`} className="text-base font-semibold">
                      Route overrides
                    </h2>
                    <p className="text-muted-foreground text-sm">
                      Per-route limits registered by the gateway. Pausing a route disables its limiter entirely.
                    </p>
                  </div>
                  <FilterBar shown={filteredRoutes.length} total={routes.length}>
                    <FilterSearch label="Search routes" placeholder="Search routes…" value={search} onChange={(value) => void setSearch(value)} />
                    <FilterSelect
                      id="rate-limits-tier"
                      label="Tier"
                      value={tierFilter}
                      onChange={(value) => void setTierFilter(value)}
                      options={policy.tiers.map((tier) => ({ value: tier.tier, label: tier.tier }))}
                    />
                    <FilterSelect
                      id="rate-limits-status"
                      label="Status"
                      value={statusFilter}
                      onChange={(value) => void setStatusFilter(value)}
                      options={STATUS_OPTIONS}
                    />
                  </FilterBar>
                  <VirtualizedDataGrid<RateLimitRoutePolicy>
                    aria-label="Route overrides"
                    columns={routeColumns}
                    data={filteredRoutes}
                    getRowId={(route) => route.routeId}
                    height={360}
                    toolbar={false}
                    features={{
                      globalSearch: false,
                      facetedFilters: false,
                      sorting: false,
                      rowSelection: false,
                      columnReorder: false,
                      columnResize: false,
                      columnPinning: false,
                      columnVisibility: false,
                    }}
                    emptyState={
                      <EmptyState
                        icon={IconRoute}
                        title="No rate-limited routes"
                        description={
                          routes.length > 0
                            ? 'No routes match the current filters.'
                            : 'Built-in tier defaults apply until the gateway registers rate-limited routes.'
                        }
                      />
                    }
                  />
                </section>
              </>
            ) : null}
          </TabsContent>
          <TabsContent value="rules">
            <RateLimitRulesPanel />
          </TabsContent>
          <TabsContent value="plans">
            <RateLimitPlansPanel />
          </TabsContent>
          <TabsContent value="explain">
            <RateLimitExplainPanel />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable rate limiting?"
        description="Every route loses sliding-window protection until rate limiting is re-enabled. Abusive traffic is no longer throttled."
        confirmLabel="Disable rate limiting"
        destructive
        isPending={enabledMutation.isPending}
        onConfirm={() => mutateEnabled(false)}
      />
      <ConfirmDialog
        open={pauseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPauseTarget(null);
        }}
        title="Pause rate limiting for this route?"
        description={
          <>
            Requests to <span className="font-mono">{pauseTarget?.routeId}</span> bypass the limiter until the route is resumed.
          </>
        }
        confirmLabel="Pause route"
        destructive
        isPending={routeMutation.isPending}
        onConfirm={() => {
          if (pauseTarget) setRouteEnabled(pauseTarget, false);
        }}
      />
      {tierEdit ? (
        <OverrideDialog
          key={`tier-${tierEdit.tier}`}
          title={`Edit ${tierEdit.tier} tier`}
          description="Requests allowed per TTL window for routes on this tier. The override persists to the DB."
          initialLimit={tierEdit.limit}
          initialTtl={tierEdit.ttl}
          isPending={tierMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setTierEdit(null);
          }}
          onSave={(limit, ttl) => {
            tierMutation.mutate(
              { tier: tierEdit.tier, body: { limit, ttl } },
              {
                onSuccess: () => {
                  toast.success(`Tier ${tierEdit.tier} updated`);
                  setTierEdit(null);
                },
                onError: (error) => toast.error(error.message),
              },
            );
          }}
        />
      ) : null}
      {routeEdit ? (
        <OverrideDialog
          key={`route-${routeEdit.routeId}`}
          title={`Edit ${routeEdit.routeId}`}
          description="Route-level limit and window. The override takes precedence over the tier default and persists to the DB."
          initialLimit={routeEdit.limit}
          initialTtl={routeEdit.ttl}
          isPending={routeMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setRouteEdit(null);
          }}
          onSave={(limit, ttl) => {
            routeMutation.mutate(
              { routeId: routeEdit.routeId, body: { limit, ttl } },
              {
                onSuccess: () => {
                  toast.success('Route override saved');
                  setRouteEdit(null);
                },
                onError: (error) => toast.error(error.message),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}
