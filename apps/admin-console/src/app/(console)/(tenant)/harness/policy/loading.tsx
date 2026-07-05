import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the harness-policy screen: header, tabs, resolve card + grid, form. */
export default function HarnessPolicyLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-96 max-w-full" />
                <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-9 w-80 max-w-full" />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <Skeleton className="h-48" />
                <div className="flex flex-col gap-3 rounded-md border p-3">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                    ))}
                </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="h-40" />
                <Skeleton className="h-40" />
            </div>
        </div>
    );
}
