import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the tenant-storage screen: header, tabs, filter bar, buckets table. */
export default function TenantStorageLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-72" />
                    <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="h-9 w-40" />
            </div>
            <Skeleton className="h-9 w-80" />
            <Skeleton className="h-13 w-full" />
            <div className="flex flex-col gap-3 rounded-md border p-3">
                {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                ))}
            </div>
        </div>
    );
}
