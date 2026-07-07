import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the LLM playground: header, prompt/output/providers panes, footer bar. */
export default function PlaygroundLlmLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-4 w-96" />
                </div>
                <Skeleton className="h-9 w-28" />
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)]">
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-40 w-full" />
                    <Skeleton className="h-20 w-full" />
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-40 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                </div>
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-40" />
                    {Array.from({ length: 3 }, (_, index) => (
                        <Skeleton key={index} className="h-16 w-full" />
                    ))}
                </div>
            </div>
            <Skeleton className="h-8 w-full" />
        </div>
    );
}
