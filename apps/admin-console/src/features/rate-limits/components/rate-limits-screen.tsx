'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconPencil, IconPlayerPause, IconPlayerPlay, IconRoute } from '@tabler/icons-react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { useRateLimitPolicy, useSetRateLimitEnabled, useSetRouteOverride, useSetTierOverride } from '../api/hooks';
import type { RateLimitRoutePolicy, RateLimitTierPolicy } from '../api/types';

const STATUS_OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'paused', label: 'Paused' },
];

function SourceBadges({ limitSource, ttlSource }: { limitSource: string; ttlSource: string }) {
    return (
        <span className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                limit: {limitSource}
            </Badge>
            <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
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
                            <Input
                                id={`${uid}-limit`}
                                type="number"
                                min={1}
                                required
                                value={limit}
                                onChange={(event) => setLimit(event.target.value)}
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-ttl`}>TTL (seconds)</Label>
                            <Input
                                id={`${uid}-ttl`}
                                type="number"
                                min={1}
                                required
                                value={ttl}
                                onChange={(event) => setTtl(event.target.value)}
                            />
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

    const tierColumns: DataTableColumn<RateLimitTierPolicy>[] = [
        {
            key: 'tier',
            header: 'Tier',
            cell: (tier) => <span className="font-medium">{tier.tier}</span>,
        },
        {
            key: 'limit',
            header: 'Limit',
            cell: (tier) => <span className="tabular-nums">{formatNumber(tier.limit)}</span>,
        },
        {
            key: 'ttl',
            header: 'Window',
            cell: (tier) => <span className="text-muted-foreground tabular-nums">{formatNumber(tier.ttl)} s</span>,
        },
        {
            key: 'sources',
            header: 'Sources',
            cell: (tier) => <SourceBadges limitSource={tier.limitSource} ttlSource={tier.ttlSource} />,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            headerClassName: 'w-12',
            cell: (tier) => (
                <span className="flex justify-end">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${tier.tier} tier`} onClick={() => setTierEdit(tier)}>
                        <IconPencil aria-hidden />
                    </Button>
                </span>
            ),
        },
    ];

    const routeColumns: DataTableColumn<RateLimitRoutePolicy>[] = [
        {
            key: 'route',
            header: 'Route',
            mono: true,
            cell: (route) => route.routeId,
        },
        {
            key: 'description',
            header: 'Description',
            cell: (route) => <span className="text-muted-foreground">{route.description}</span>,
        },
        {
            key: 'tier',
            header: 'Tier',
            cell: (route) => <Badge variant="secondary">{route.tier}</Badge>,
        },
        {
            key: 'limit',
            header: 'Limit',
            cell: (route) => (
                <span className="tabular-nums">
                    {formatNumber(route.limit)} <span className="text-muted-foreground">/ {formatNumber(route.ttl)} s</span>
                </span>
            ),
        },
        {
            key: 'sources',
            header: 'Sources',
            cell: (route) => <SourceBadges limitSource={route.limitSource} ttlSource={route.ttlSource} />,
        },
        {
            key: 'status',
            header: 'Status',
            cell: (route) =>
                route.enabled ? (
                    <StatusBadge label="Active" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
                ) : (
                    <StatusBadge label="Paused" colorRole="neutral" icon={<StatusDot colorRole="neutral" size="sm" />} />
                ),
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            headerClassName: 'w-20',
            cell: (route) => (
                <span className="flex items-center justify-end gap-1">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${route.routeId}`}
                        disabled={routeMutation.isPending}
                        onClick={() => setRouteEdit(route)}
                    >
                        <IconPencil aria-hidden />
                    </Button>
                    {route.enabled ? (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Pause ${route.routeId}`}
                            disabled={routeMutation.isPending}
                            onClick={() => setPauseTarget(route)}
                        >
                            <IconPlayerPause aria-hidden />
                        </Button>
                    ) : (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Resume ${route.routeId}`}
                            disabled={routeMutation.isPending}
                            onClick={() => setRouteEnabled(route, true)}
                        >
                            <IconPlayerPlay aria-hidden />
                        </Button>
                    )}
                </span>
            ),
        },
    ];

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                title="Rate Limits"
                meta={
                    <>
                        {policy ? (
                            <>
                                <span>{formatNumber(policy.tiers.length)} tiers</span>
                                <span aria-hidden>&middot;</span>
                                <span>{formatNumber(policy.routes.length)} routes</span>
                                <span aria-hidden>&middot;</span>
                            </>
                        ) : null}
                        <span className="font-mono text-xs">GET /admin/rate-limit</span>
                    </>
                }
            />
            {query.isPending ? (
                <RateLimitsSkeleton />
            ) : query.error && !policy ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : policy ? (
                <>
                    {query.error ? <ErrorBanner error={query.error} onRetry={() => void query.refetch()} /> : null}
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
                            <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
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
                        <DataTable
                            aria-label="Tier defaults"
                            columns={tierColumns}
                            rows={policy.tiers}
                            rowKey={(tier) => tier.tier}
                            skeletonRows={4}
                            empty={<EmptyState icon={IconRoute} title="No tiers reported" description="The gateway did not report any guard tiers." />}
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
                        <DataTable
                            aria-label="Route overrides"
                            columns={routeColumns}
                            rows={filteredRoutes}
                            rowKey={(route) => route.routeId}
                            empty={
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
                        Requests to <span className="font-mono">{pauseTarget?.routeId}</span> bypass the limiter until the route is
                        resumed.
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
        </div>
    );
}
