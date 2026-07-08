import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the entitlements screen: header, enforcement card, tabs, plans table. */
export default function EntitlementsLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="h-9 w-36" />
            </div>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-64" />
            <div className="flex flex-col gap-3 rounded-md border p-3">
                {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                ))}
            </div>
        </div>
    );
}
