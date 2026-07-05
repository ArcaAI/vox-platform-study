import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the workflows screen: header, filter bar, detail + grid + signals. */
export default function HarnessWorkflowsLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-4 w-96" />
                </div>
                <Skeleton className="h-9 w-28" />
            </div>
            <Skeleton className="h-13 w-full" />
            <div className="grid gap-4 xl:grid-cols-4">
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-32 w-full" />
                </div>
                <div className="flex flex-col gap-3 xl:col-span-2">
                    <div className="flex flex-col gap-3 rounded-md border p-3">
                        {Array.from({ length: 8 }, (_, index) => (
                            <Skeleton key={index} className="h-8 w-full" />
                        ))}
                    </div>
                </div>
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-24 w-full" />
                </div>
            </div>
        </div>
    );
}
