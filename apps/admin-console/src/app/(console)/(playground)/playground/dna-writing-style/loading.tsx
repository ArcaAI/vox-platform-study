import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring frame 53: header, then gate+settings / my-style+reports / generate columns. */
export default function PlaygroundDnaWritingStyleLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <Skeleton className="h-9 w-44" />
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,22rem)]">
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 rounded-xl border p-4">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-8 w-36" />
                    </div>
                    <div className="flex flex-col gap-3 rounded-xl border p-4">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-5 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                </div>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 rounded-xl border p-4">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-24 w-full" />
                    </div>
                    <div className="flex flex-col gap-3 rounded-xl border p-4">
                        <Skeleton className="h-4 w-28" />
                        {Array.from({ length: 3 }, (_, index) => (
                            <Skeleton key={index} className="h-9 w-full" />
                        ))}
                    </div>
                </div>
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-8 w-28 self-end" />
                </div>
            </div>
        </div>
    );
}
