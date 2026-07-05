import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded policies layout: header, filter bar, table, pagination. */
export default function RbacPoliciesLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-44" />
                    <Skeleton className="h-4 w-80 max-w-full" />
                </div>
                <Skeleton className="h-9 w-32" />
            </div>
            <div className="bg-card flex items-center gap-3 rounded-md border p-2">
                <Skeleton className="h-9 w-64 max-w-full" />
                <Skeleton className="h-8 w-28" />
                <Skeleton className="ml-auto h-4 w-28" />
            </div>
            <div className="flex flex-col gap-2 overflow-hidden rounded-md border p-2">
                <Skeleton className="h-9 w-full" />
                {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                ))}
            </div>
            <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-8 w-64 max-w-full" />
                <Skeleton className="h-8 w-40" />
            </div>
        </div>
    );
}
