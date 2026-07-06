'use client';

import { IconKey, IconMicrophone } from '@tabler/icons-react';
import { type ColumnDef, VirtualizedDataGrid } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import type { ApiKey } from '@/features/api-keys/api/types';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useUserApiKeys, useVoiceProfiles } from '../api/hooks';

/** Embedded detail-tab grids: no personalization, client-side only (rule #2). */
const EMBEDDED_GRID_FEATURES = {
    columnReorder: false,
    columnResize: false,
    columnPinning: false,
    columnVisibility: false,
    rowSelection: false,
    globalSearch: false,
    facetedFilters: false,
    sorting: true,
} as const;

const API_KEY_COLUMNS: ColumnDef<ApiKey>[] = [
    { accessorKey: 'keyName', header: 'Name', meta: { label: 'Name' }, size: 180, minSize: 140, cell: ({ row }) => <span className="font-medium">{row.original.keyName}</span> },
    { accessorKey: 'keyPrefix', header: 'Prefix', meta: { label: 'Prefix' }, size: 150, cell: ({ row }) => <span className="font-mono text-xs">{row.original.keyPrefix}</span> },
    { id: 'type', header: 'Type', enableSorting: false, meta: { label: 'Type' }, size: 110, cell: ({ row }) => <Badge variant="outline">{row.original.keyType}</Badge> },
    {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        meta: { label: 'Status' },
        size: 120,
        cell: ({ row }) => (
            <Badge variant={row.original.keyStatus === 'ACTIVE' ? 'default' : row.original.keyStatus === 'REVOKED' ? 'destructive' : 'outline'}>{row.original.keyStatus}</Badge>
        ),
    },
    { accessorKey: 'lastUsedAt', header: 'Last used', meta: { label: 'Last used' }, size: 140, cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.lastUsedAt)}</span> },
    { accessorKey: 'usageCount', header: 'Usage', meta: { label: 'Usage' }, size: 100, cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.usageCount)}</span> },
];

function VoiceProfilesCard({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useVoiceProfiles(id);
    const profiles = data ?? [];

    return (
        <Card>
            <CardHeader>
                <CardTitle>Voice profiles</CardTitle>
                <CardDescription>Enrolled speaker profiles (read-only) — enrollment happens in the consultation apps.</CardDescription>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                ) : error ? (
                    <ErrorState error={error} onRetry={() => refetch()} />
                ) : profiles.length === 0 ? (
                    <EmptyState icon={IconMicrophone} title="No voice profiles" description="This user has not enrolled a speaker profile yet." />
                ) : (
                    <ul className="flex flex-col divide-y">
                        {profiles.map((profile) => (
                            <li key={profile.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                                <span className="font-medium">{profile.label ?? profile.id}</span>
                                <Badge variant={profile.isActive ? 'default' : 'outline'}>{profile.isActive ? 'Active' : 'Inactive'}</Badge>
                                {profile.modelId ? <span className="text-muted-foreground font-mono text-xs">{profile.modelId}</span> : null}
                                <span className="text-muted-foreground ml-auto text-sm">enrolled {formatDateTime(profile.createdAt, 'date')}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function ApiKeysCard({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useUserApiKeys(id);
    const rows = data?.data ?? [];

    return (
        <Card>
            <CardHeader>
                <CardTitle>API keys</CardTitle>
                <CardDescription>Keys owned by this user (read-only) — manage them on the API keys screen.</CardDescription>
            </CardHeader>
            <CardContent>
                <VirtualizedDataGrid<ApiKey>
                    aria-label="User API keys"
                    columns={API_KEY_COLUMNS}
                    data={rows}
                    getRowId={(row) => row.id}
                    features={EMBEDDED_GRID_FEATURES}
                    height={300}
                    isLoading={isLoading}
                    error={error}
                    onRetry={() => refetch()}
                    emptyState={<EmptyState icon={IconKey} title="No API keys" description="This user owns no API keys." />}
                />
            </CardContent>
        </Card>
    );
}

/** Frame 20.1 security tab: reset-password entry + read-only credentials. */
export function UserSecurityTab({ id, onResetPassword }: { id: string; onResetPassword: () => void }) {
    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>Password</CardTitle>
                    <CardDescription>Mints a single-use reset link; the user chooses a new password on first use.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Button variant="outline" onClick={onResetPassword}>
                        <IconKey aria-hidden />
                        Reset password
                    </Button>
                </CardContent>
            </Card>
            <VoiceProfilesCard id={id} />
            <ApiKeysCard id={id} />
        </div>
    );
}
