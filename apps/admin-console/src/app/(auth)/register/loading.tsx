import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

export default function RegisterLoading() {
    return (
        <main className="flex min-h-svh items-center justify-center p-6">
            <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border p-6">
                <Skeleton className="h-6 w-56" />
                <Skeleton className="h-4 w-64" />
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                ))}
                <Skeleton className="h-9 w-full" />
            </div>
        </main>
    );
}
