import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the observability screen: header, filter bar, 3-panel grid. */
export default function HarnessObservabilityLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-72" />
                    <Skeleton className="h-4 w-96" />
                </div>
                <Skeleton className="h-9 w-28" />
            </div>
            <Skeleton className="h-13 w-full" />
            <div className="grid gap-4 xl:grid-cols-3">
                {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className="flex flex-col gap-3 rounded-xl border p-4">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-5 w-28 rounded-full" />
                        {Array.from({ length: 5 }, (_, row) => (
                            <Skeleton key={row} className="h-8 w-full" />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
