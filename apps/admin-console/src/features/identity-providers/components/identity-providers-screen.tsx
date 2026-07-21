'use client';

import { useMemo, useState } from 'react';
import { IconKey, IconPlus } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDeleteIdentityProvider, useIdentityProviders } from '../api/hooks';
import type { IdpStatus, TenantIdpConfig } from '../api/types';
import { IdentityProviderDetailDrawer } from './identity-provider-detail';

const STATUS_BADGE: Record<IdpStatus, { label: string; variant: 'outline' | 'secondary' | 'destructive' }> = {
    DRAFT: { label: 'Draft', variant: 'outline' },
    ENABLED: { label: 'Enabled', variant: 'secondary' },
    DISABLED: { label: 'Disabled', variant: 'destructive' },
};

function IdentityProvidersScreenBody() {
    const [selectedParam, setSelectedParam] = useQueryState('provider', parseAsString.withDefault(''));
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<TenantIdpConfig | null>(null);

    const providersQuery = useIdentityProviders();
    const deleteProvider = useDeleteIdentityProvider();

    const rows = providersQuery.data ?? [];
    const count = rows.length;

    const columns = useMemo<ColumnDef<TenantIdpConfig>[]>(
        () => [
            {
                accessorKey: 'displayName',
                header: 'Provider',
                enableSorting: false,
                enableHiding: false,
                size: 220,
                minSize: 140,
                meta: { label: 'Provider' },
                cell: ({ row }) => <span className="font-medium">{row.original.displayName}</span>,
            },
            {
                accessorKey: 'protocol',
                header: 'Protocol',
                enableSorting: false,
                enableHiding: false,
                size: 110,
                meta: { label: 'Protocol' },
                cell: ({ row }) => <Badge variant="outline">{row.original.protocol}</Badge>,
            },
            {
                accessorKey: 'providerStatus',
                header: 'Status',
                enableSorting: false,
                enableHiding: false,
                size: 120,
                meta: { label: 'Status' },
                cell: ({ row }) => {
                    const badge = STATUS_BADGE[row.original.providerStatus];
                    return <Badge variant={badge.variant}>{badge.label}</Badge>;
                },
            },
            {
                id: 'issuer',
                header: 'Issuer',
                enableSorting: false,
                enableHiding: false,
                size: 240,
                meta: { label: 'Issuer' },
                cell: ({ row }) => <span className="text-muted-foreground truncate font-mono text-xs">{row.original.config.issuer}</span>,
            },
            {
                id: 'directorySync',
                header: 'Directory sync',
                enableSorting: false,
                enableHiding: false,
                size: 140,
                meta: { label: 'Directory sync' },
                cell: ({ row }) =>
                    row.original.config.directoryProvider ? (
                        <Badge variant="outline">{row.original.config.directoryProvider === 'ms-graph' ? 'MS Graph' : 'Google'}</Badge>
                    ) : (
                        <span className="text-muted-foreground">{'— off —'}</span>
                    ),
            },
        ],
        [],
    );

    const empty = (
        <EmptyState
            icon={IconKey}
            title="No identity providers configured"
            description="Connect a tenant-scoped OIDC identity provider (Okta, Entra ID, Google, Keycloak) so your users can sign in with single sign-on."
            action={
                <Button onClick={() => setCreating(true)}>
                    <IconPlus aria-hidden />
                    New provider
                </Button>
            }
        />
    );

    function handleDeleteConfirmed() {
        if (!deleting) return;
        deleteProvider.mutate(deleting.id, {
            onSuccess: () => {
                toast.success('Identity provider deleted');
                if (deleting.id === selectedParam) void setSelectedParam(null);
                setDeleting(null);
            },
            onError: (error) => {
                toast.error(error instanceof GatewayError ? error.message : 'Could not delete the identity provider.');
                setDeleting(null);
            },
        });
    }

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Identity Providers"
                        meta={providersQuery.data ? <span>{formatNumber(count)} providers</span> : <Skeleton className="h-4 w-24" />}
                        actions={
                            <Button onClick={() => setCreating(true)}>
                                <IconPlus aria-hidden />
                                New provider
                            </Button>
                        }
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>{providersQuery.isFetching && !providersQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/tenant-idp-config
                            </span>
                        }
                    />
                }
            >
                <VirtualizedDataGrid<TenantIdpConfig>
                    aria-label="Identity providers"
                    columns={columns}
                    data={rows}
                    getRowId={(row) => row.id}
                    manual={{ filtering: false, pagination: false }}
                    rowCount={count}
                    features={{
                        columnReorder: false,
                        columnResize: true,
                        columnPinning: false,
                        columnVisibility: false,
                        rowSelection: false,
                        globalSearch: false,
                        facetedFilters: false,
                        sorting: false,
                    }}
                    onRowClick={(row) => void setSelectedParam(row.id)}
                    isLoading={providersQuery.isLoading}
                    isBusy={providersQuery.isFetching && !providersQuery.isLoading}
                    error={rows.length > 0 ? null : (providersQuery.error ?? null)}
                    errorState={(error) => <ErrorState error={error} onRetry={() => void providersQuery.refetch()} />}
                    onRetry={() => void providersQuery.refetch()}
                    emptyState={empty}
                />
            </ScreenTemplate>

            <IdentityProviderDetailDrawer
                key={creating ? 'create' : selectedParam || 'no-provider'}
                providerId={creating ? null : selectedParam || null}
                creating={creating}
                onOpenChange={(open) => {
                    if (open) return;
                    setCreating(false);
                    void setSelectedParam(null);
                }}
                onCreated={(provider) => {
                    setCreating(false);
                    void setSelectedParam(provider.id);
                }}
                onRequestDelete={setDeleting}
            />

            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete identity provider?"
                description={
                    deleting
                        ? `Soft-deletes "${deleting.displayName}". Users who federate through it can no longer sign in via SSO; their existing HOPE accounts are unaffected.`
                        : ''
                }
                confirmLabel="Delete provider"
                destructive
                typeToConfirm={deleting?.displayName}
                onConfirm={handleDeleteConfirmed}
                isPending={deleteProvider.isPending}
            />
        </>
    );
}

/** Tier 30-49 — tenant-scoped external identity provider (OIDC) administration. */
export function IdentityProvidersScreen() {
    return (
        <WorkingTenantGate
            title="Identity Providers"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET /admin/tenant-idp-config
                </span>
            }
            description="External identity providers are configured per tenant. Pick a working tenant from the switcher in the top bar to load its providers."
        >
            <IdentityProvidersScreenBody />
        </WorkingTenantGate>
    );
}
