import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the pipeline-policy screen: header, filter bar, three panels. */
export default function PipelinePolicyLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-96 max-w-full" />
                <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-13 w-full" />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1.2fr)]">
                <Skeleton className="h-52" />
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    {Array.from({ length: 5 }, (_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                    ))}
                </div>
                <Skeleton className="h-52" />
            </div>
        </div>
    );
}
