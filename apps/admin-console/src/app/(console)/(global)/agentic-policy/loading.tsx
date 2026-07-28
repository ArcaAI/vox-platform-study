import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the Agentic Policy screen: header + tab strip + knob cards. */
export default function AgenticPolicyLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-80 max-w-full" />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-xl border p-4">
            <Skeleton className="h-5 w-40 max-w-full" />
            <Skeleton className="h-4 w-56 max-w-full" />
            {Array.from({ length: 3 }, (_, row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
