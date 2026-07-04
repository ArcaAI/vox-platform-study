import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the placeholder Empty block until the designed dashboard lands. */
export default function DashboardLoading() {
    return (
        <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-72" />
            </div>
        </div>
    );
}
