import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Mirrors the loaded account layout: header, identity card, settings rows, preferences form. */
export default function AccountLoading() {
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            <div className="bg-card rounded-xl border p-6">
                <div className="flex items-center gap-4">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-4 w-56 max-w-full" />
                    </div>
                </div>
            </div>
            <div className="flex flex-col gap-2 rounded-md border p-3">
                {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                ))}
            </div>
            <Skeleton className="h-64" />
        </div>
    );
}
