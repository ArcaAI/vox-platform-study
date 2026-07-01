import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Progress } from '@arcaai/ui/progress';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useTenantBuckets, useTenants, type TenantBucket, type TenantUsageStats } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Database, HardDrive, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { formatBytes } from '@/features/platform-dashboard';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/storage')({
    component: TenantStoragePage,
});

function bucketProvider(b: TenantBucket): string | null {
    const provider = typeof b.provider === 'string' ? b.provider : undefined;
    const region = typeof b.region === 'string' ? b.region : undefined;
    return [provider, region].filter(Boolean).join(' · ') || (typeof b.purpose === 'string' ? b.purpose : null);
}

function TenantStoragePage() {
    const { tenantId } = Route.useParams();
    const tenant = useTenantDetailStore((s) => s.tenant);
    const roles = useAuthStore((s) => s.user?.roles);
    const superAdmin = isSuperAdmin(roles);

    const { buckets, isLoading, error, list } = useTenantBuckets();
    // TASK-386 E5 (#5) — storage used/quota roll-up for this tenant (Postgres-derived).
    const { getUsage } = useTenants();
    const [usage, setUsage] = useState<TenantUsageStats | null>(null);

    useEffect(() => {
        void list().catch(() => undefined);
        void getUsage(tenantId)
            .then(setUsage)
            .catch(() => setUsage(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    const usagePct =
        usage && usage.storageQuotaBytes != null && usage.storageQuotaBytes > 0
            ? Math.min(100, Math.round((usage.storageUsedBytes / usage.storageQuotaBytes) * 100))
            : null;

    return (
        <div className="space-y-5">
            {/* TASK-386 E5 — REAL storage used/quota (SUM Media.size / SUM TenantBucket.quotaBytes). */}
            <Card className="p-5">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Usage</h2>
                    <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                </div>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    <div>
                        <span className="text-2xl font-semibold tabular-nums">{formatBytes(usage?.storageUsedBytes)}</span>
                        <span className="ml-2 text-sm text-muted-foreground">
                            {usage?.storageQuotaBytes != null ? `of ${formatBytes(usage.storageQuotaBytes)} quota` : 'used · no quota set'}
                        </span>
                    </div>
                    {usagePct != null ? <span className="text-sm font-medium tabular-nums text-muted-foreground">{usagePct}%</span> : null}
                </div>
                {usagePct != null ? <Progress className="mt-3" value={usagePct} aria-label={`Storage usage ${usagePct}%`} /> : null}
            </Card>

            <Card className="overflow-hidden">
                <div className="border-b border-border px-5 py-3">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Buckets</h2>
                </div>
                {isLoading && buckets.length === 0 ? (
                    <div className="space-y-2 p-5">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                ) : error ? (
                    <div role="alert" className="flex flex-col items-center gap-2 p-10 text-center">
                        <TriangleAlert className="size-8 text-destructive" />
                        <p className="font-medium">Couldn’t load buckets</p>
                        <p className="text-sm text-muted-foreground">{error.message}</p>
                        <Button variant="outline" onClick={() => void list().catch(() => undefined)}>
                            Retry
                        </Button>
                    </div>
                ) : buckets.length === 0 ? (
                    <Empty>
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Database />
                            </EmptyMedia>
                            <EmptyTitle>No buckets</EmptyTitle>
                            <EmptyDescription>Storage buckets are provisioned per tenant (TenantBucket).</EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                                <th className="px-5 py-2.5 font-medium">Bucket</th>
                                <th className="px-5 py-2.5 font-medium">Objects</th>
                                <th className="px-5 py-2.5 font-medium">Size</th>
                                <th className="px-5 py-2.5 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {buckets.map((b) => {
                                const provider = bucketProvider(b);
                                const status = typeof b.resourceStatus === 'string' ? b.resourceStatus : typeof b.status === 'string' ? b.status : undefined;
                                return (
                                    <tr key={b.id}>
                                        <td className="px-5 py-3">
                                            <div className="flex flex-col">
                                                <span className="font-mono font-medium">{b.name || b.id}</span>
                                                {provider ? <span className="text-xs text-muted-foreground">{provider}</span> : null}
                                            </div>
                                        </td>
                                        {/* TARGET: object count + size are not modeled on TenantBucket. */}
                                        <td className="px-5 py-3 text-muted-foreground">—</td>
                                        <td className="px-5 py-3 text-muted-foreground">—</td>
                                        <td className="px-5 py-3">
                                            {status ? (
                                                <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} />
                                            ) : (
                                                <StatusBadge label="Active" colorRole="success" />
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
                    <p className="text-xs text-muted-foreground">Object storage · per-tenant buckets (TenantBucket).</p>
                    <div className="flex gap-2">
                        {/* TARGET: key rotation / provider config endpoints are not exposed as hooks. */}
                        <Button variant="outline" size="sm" disabled title="Not yet available">
                            Rotate keys
                        </Button>
                        <Button variant="outline" size="sm" disabled title="Not yet available">
                            Manage provider
                        </Button>
                    </div>
                </div>
            </Card>

            {superAdmin && tenant ? (
                <ActingOnBanner
                    tenantName={tenant.name}
                    description="Buckets are provisioned per tenant (TenantBucket). Storage usage is the SUM of stored media; quota is the SUM of per-bucket quotas. Per-bucket object counts/sizes remain a target surface."
                />
            ) : null}
        </div>
    );
}
