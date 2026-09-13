import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Segment loading state — skeletons shaped like the invoke guide's card stack, including its two tables (rule 10). */
export default function InvokeGuideLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-96 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden">
        <div className="flex flex-col gap-3 rounded-md border p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="flex flex-col gap-3 rounded-md border p-6">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-full max-w-md" />
          <div className="grid gap-2">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-md border p-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
      <Skeleton className="h-8 w-full shrink-0" />
    </div>
  );
}
