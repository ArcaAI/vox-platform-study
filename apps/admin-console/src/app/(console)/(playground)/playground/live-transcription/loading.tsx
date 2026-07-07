import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Route-level fallback mirroring frame 51: header + toolbar + tabs + two-pane body. */
export default function LiveTranscriptionLoading() {
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-4 w-80" />
                </div>
                <Skeleton className="h-11 w-36" />
            </div>
            <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-9 w-64" />
            </div>
            <Skeleton className="h-9 w-72" />
            <div className="grid flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                <Skeleton className="h-72 w-full" />
                <Skeleton className="h-72 w-full" />
            </div>
            <Skeleton className="h-8 w-full" />
        </div>
    );
}
