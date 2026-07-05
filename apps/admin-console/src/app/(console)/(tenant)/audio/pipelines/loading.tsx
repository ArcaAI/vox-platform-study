import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the audio-pipelines screen: header, filter bar, three panels. */
export default function AudioPipelinesLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <Skeleton className="h-9 w-36" />
            </div>
            <Skeleton className="h-13 w-full" />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
                <Skeleton className="h-80 w-full" />
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                    ))}
                </div>
                <Skeleton className="h-80 w-full" />
            </div>
        </div>
    );
}
