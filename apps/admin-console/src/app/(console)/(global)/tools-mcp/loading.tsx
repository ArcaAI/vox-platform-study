import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Tools & MCP screen: header + read-only banner + 2×2 cards. */
export default function ToolsMcpLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-48 max-w-full" />
                <Skeleton className="h-4 w-72 max-w-full" />
            </div>
            <Skeleton className="h-16 w-full" />
            <div className="grid items-start gap-4 lg:grid-cols-2">
                {Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className="rounded-xl border p-6">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="mt-4 h-32 w-full" />
                    </div>
                ))}
            </div>
        </div>
    );
}
