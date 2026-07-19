import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Prompt Studio master-detail: header + list rail + detail. */
export default function PromptStudioLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-56 max-w-full" />
                <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                <div className="flex flex-col gap-2 rounded-xl border p-3">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-12 w-full" />
                    ))}
                </div>
                <div className="flex flex-col gap-4">
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-56 w-full" />
                </div>
            </div>
        </div>
    );
}
