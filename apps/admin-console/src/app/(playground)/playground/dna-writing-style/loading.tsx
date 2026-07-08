import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Route-level skeleton mirroring the centered DNA writing-style canvas (artboard 4e). */
export default function PlaygroundDnaWritingStyleLoading() {
    return (
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-7 w-64" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <Skeleton className="h-9 w-44" />
            </div>
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                </div>
            ))}
        </div>
    );
}
