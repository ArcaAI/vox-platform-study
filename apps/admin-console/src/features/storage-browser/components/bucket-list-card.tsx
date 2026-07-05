'use client';

import { IconBucket, IconCircle, IconCircleDot } from '@tabler/icons-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useStorageHealth } from '../api/hooks';
import type { StorageBucket, StorageHealth } from '../api/types';

function healthLabel(health: StorageHealth): string {
    if (health.status === 'not-configured') return 'Storage not configured';
    if (health.status === 'healthy' && health.connected) return health.isMinIO ? 'MinIO reachable' : 'Storage reachable';
    return health.isMinIO ? 'MinIO unreachable' : 'Storage unreachable';
}

function healthDotClass(health: StorageHealth): string {
    if (health.status === 'healthy' && health.connected) return 'bg-success';
    if (health.status === 'not-configured') return 'bg-warning';
    return 'bg-destructive';
}

/** Storage health line (frame 31 bucket-card footer): dot + probe verdict. */
function HealthLine() {
    const { data, isPending, isError } = useStorageHealth();

    if (isPending) {
        return <Skeleton className="h-4 w-36" />;
    }

    const health: StorageHealth = isError ? { status: 'unhealthy', connected: false, isMinIO: false } : (data as StorageHealth);
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-2 text-sm">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${healthDotClass(health)}`} />
                <span className="truncate">Health: {healthLabel(health)}</span>
            </span>
            <span aria-hidden className="text-muted-foreground font-mono text-xs">
                GET /storage/health
            </span>
        </div>
    );
}

/**
 * Frame 31 left panel: radio-like bucket picker. Native radios keep the
 * arrow-key group navigation; the visible dot mirrors the checked state.
 * The data-plane listing carries no per-bucket sizes (only name + creation
 * date), so the secondary line shows the creation date instead.
 */
export function BucketListCard({
    buckets,
    isLoading,
    activeBucket,
    onSelect,
}: {
    buckets: StorageBucket[];
    isLoading: boolean;
    activeBucket: string;
    onSelect: (name: string) => void;
}) {
    return (
        <Card className="gap-4 self-start py-4">
            <CardHeader className="px-4">
                <CardTitle>Buckets</CardTitle>
                <CardDescription aria-hidden className="font-mono text-xs">
                    GET /storage/buckets
                </CardDescription>
            </CardHeader>
            <CardContent className="px-2">
                {isLoading ? (
                    <div className="flex flex-col gap-2 px-2">
                        {Array.from({ length: 3 }, (_, index) => (
                            <Skeleton key={index} className="h-8 w-full" />
                        ))}
                    </div>
                ) : buckets.length === 0 ? (
                    <EmptyState icon={IconBucket} title="No buckets" description="This tenant has no storage buckets registered yet." />
                ) : (
                    <fieldset>
                        <legend className="sr-only">Select a bucket</legend>
                        <div className="flex flex-col gap-0.5">
                            {buckets.map((bucket) => {
                                const checked = bucket.name === activeBucket;
                                return (
                                    <label
                                        key={bucket.name}
                                        className="hover:bg-muted/50 has-[:checked]:bg-muted has-[:focus-visible]:ring-ring flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 has-[:focus-visible]:ring-2"
                                    >
                                        <input
                                            type="radio"
                                            name="storage-browser-bucket"
                                            className="sr-only"
                                            checked={checked}
                                            onChange={() => onSelect(bucket.name)}
                                        />
                                        {checked ? (
                                            <IconCircleDot aria-hidden className="text-primary size-4 shrink-0" />
                                        ) : (
                                            <IconCircle aria-hidden className="text-muted-foreground size-4 shrink-0" />
                                        )}
                                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{bucket.name}</span>
                                        <span className="text-muted-foreground shrink-0 text-xs">{formatRelativeTime(bucket.creationDate)}</span>
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>
                )}
            </CardContent>
            <CardFooter className="border-t px-4 [.border-t]:pt-3">
                <HealthLine />
            </CardFooter>
        </Card>
    );
}
