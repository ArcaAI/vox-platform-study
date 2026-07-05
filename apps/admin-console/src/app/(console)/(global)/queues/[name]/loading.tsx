import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the queue detail: header + actions, counter tiles, jobs table. */
export default function QueueDetailLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <div className="flex gap-2">
                    <Skeleton className="h-9 w-24" />
                    <Skeleton className="h-9 w-28" />
                </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-24 w-full rounded-xl" />
                ))}
            </div>
            <Skeleton className="h-[54px] w-full rounded-md" />
            <div className="flex flex-col overflow-hidden rounded-md border">
                <div className="bg-muted/50 border-b p-3">
                    <Skeleton className="h-4 w-2/3" />
                </div>
                <div className="flex flex-col gap-4 p-4">
                    {Array.from({ length: 8 }, (_, index) => (
                        <Skeleton key={index} className="h-5 w-full" />
                    ))}
                </div>
            </div>
        </div>
    );
}
