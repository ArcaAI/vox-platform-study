'use client';

import { useState } from 'react';
import { IconClockExclamation, IconFilterOff, IconLicense } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
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
import { FilterBar, FilterSearch } from '@/shared/data/filter-bar';
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
import { FEATURE_FIELDS, PLAN_LABELS, planSummary } from './plan-meta';
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

/** Feature chips shown before the +N overflow badge (single-line cell, TASK-429). */
const FEATURE_BADGE_LIMIT = 2;

/** Frame 13 plans table: client-side search over the fixed plan set. */
function PlansTab() {
    const { data, isLoading, error, refetch } = usePlanEntitlements();
    const [search, setSearch] = useQueryState('search', parseAsString.withDefault(''));
    const [editing, setEditing] = useState<TenantPlan | null>(null);

    const plans = data ?? [];
    const rows = search ? plans.filter((plan) => PLAN_LABELS[plan.plan].toLowerCase().includes(search.toLowerCase())) : plans;

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
            id: 'features',
            header: 'Features',
            enableSorting: false,
            meta: { label: 'Features' },
            // Single line, capped at +N — wrapping badges outgrow the fixed-height grid row (TASK-429).
            cell: ({ row }) => {
                const enabled = FEATURE_FIELDS.filter((field) => row.original[field.key]);
                if (enabled.length === 0) return <span className="text-muted-foreground">{'\u2014'}</span>;
                const shown = enabled.slice(0, FEATURE_BADGE_LIMIT);
                const extra = enabled.length - shown.length;
                return (
                    <span className="flex items-center gap-1">
                        {shown.map((field) => (
                            <Badge key={field.key} variant="secondary">
                                {field.label}
                            </Badge>
                        ))}
                        {extra > 0 ? <Badge variant="outline">+{extra}</Badge> : null}
                    </span>
                );
            },
            size: 260,
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

    const empty = search ? (
        <EmptyState
            icon={IconFilterOff}
            title="No plans match your search"
            description="Try a different search or clear it."
            action={
                <Button variant="outline" onClick={() => setSearch(null)}>
                    <IconFilterOff aria-hidden />
                    Clear search
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconLicense}
            title="No plan entitlements yet"
            description="Tenants keep implicit defaults until the gateway seeds plan entitlements."
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <FilterBar shown={rows.length} total={plans.length}>
                <FilterSearch
                    label="Search plans"
                    placeholder={'Search plans\u2026'}
                    value={search}
                    onChange={(value) => setSearch(value || null)}
                />
            </FilterBar>
            <VirtualizedDataGrid<PlanEntitlement>
                aria-label="Plan entitlements"
                columns={columns}
                data={rows}
                getRowId={(row) => row.id}
                height={360}
                features={{
                    globalSearch: false,
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
        </div>
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
                <TabsContent value="plans">
                    <PlansTab />
                </TabsContent>
                <TabsContent value="overrides">
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
