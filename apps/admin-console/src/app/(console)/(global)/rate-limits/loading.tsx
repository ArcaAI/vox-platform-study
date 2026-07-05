import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded policy layout: header, kill-switch row, two table regions. */
export default function RateLimitsLoading() {
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-44" />
                <Skeleton className="h-4 w-72 max-w-full" />
            </div>
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
