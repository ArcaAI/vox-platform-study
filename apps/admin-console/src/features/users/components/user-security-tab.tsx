'use client';

import { IconKey, IconMicrophone } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import type { ApiKey } from '@/features/api-keys/api/types';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useUserApiKeys, useVoiceProfiles } from '../api/hooks';

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

    const columns: DataTableColumn<ApiKey>[] = [
        { key: 'name', header: 'Name', cell: (row) => <span className="font-medium">{row.keyName}</span> },
        { key: 'prefix', header: 'Prefix', mono: true, cell: (row) => row.keyPrefix },
        { key: 'type', header: 'Type', cell: (row) => <Badge variant="outline">{row.keyType}</Badge> },
        {
            key: 'status',
            header: 'Status',
            cell: (row) => <Badge variant={row.keyStatus === 'ACTIVE' ? 'default' : row.keyStatus === 'REVOKED' ? 'destructive' : 'outline'}>{row.keyStatus}</Badge>,
        },
        { key: 'lastUsed', header: 'Last used', cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.lastUsedAt)}</span> },
        { key: 'usage', header: 'Usage', cell: (row) => <span className="tabular-nums">{formatNumber(row.usageCount)}</span> },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>API keys</CardTitle>
                <CardDescription>Keys owned by this user (read-only) — manage them on the API keys screen.</CardDescription>
            </CardHeader>
            <CardContent>
                <DataTable
                    aria-label="User API keys"
                    columns={columns}
                    rows={rows}
                    rowKey={(row) => row.id}
                    isLoading={isLoading}
                    error={error}
                    onRetry={() => refetch()}
                    skeletonRows={2}
                    empty={<EmptyState icon={IconKey} title="No API keys" description="This user owns no API keys." />}
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
